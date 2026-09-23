import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import {
  CHUNK_PROMPT,
  CHUNK_SCHEMA,
  measureChunks,
  MIN_LLM_MIN,
  unlabelledChunk,
  validateParts,
  type AmbientCandidate,
  type AmbientChunk,
  type ChunkPart,
  type ChunkPromptInput,
} from "@/lib/ambient/chunks";
import type { AmbientDayMeasure } from "@/lib/ambient/intervals";
import { OTHER_BUCKET } from "@/lib/ambient/projects";
import type { AmbientLabelUsage } from "@/lib/ambient/types";
import type { CachedCall, CachedLabel, LegacyCachedChunks } from "./chunkCache";
import { hashCandidate } from "./store";

/**
 * Labelling a day one candidate at a time. The day is cut into candidates by arithmetic
 * (`buildCandidates`), and each candidate's label depends on nothing but what the model
 * was shown for it, so labels are cached per candidate under a hash of exactly that. A
 * closed stretch is paid for once. The open stretch at the end of the day is the only one
 * that changes, and it is re-labelled less often as it grows, since its label is
 * provisional until a real break closes it anyway.
 */

export const MODEL = "claude-haiku-4-5-20251001";

/** Haiku 4.5 list prices, dollars per million tokens. The estimate is for the person's eye; the bill is the console's. */
const USD_PER_MTOK = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };

/** Tracked minutes the open candidate must grow past its last label before a refresh is worth paying for. */
export const UNLABELLED_TAIL_MINUTES = 15;
/** ...and, once it has a label, at least this share of what was already labelled: a four-hour stretch refreshes hourly, not every quarter. */
export const OPEN_RELABEL_FRACTION = 0.5;
/** Rejected answers for one exact key before giving up on it until the candidate changes. */
const MAX_ATTEMPTS = 3;
/** A rejected answer is not retried sooner than this. */
const RETRY_AFTER_MS = 30 * 60_000;

type CandidateEntry = ChunkPromptInput["candidates"][number];

/** A candidate with its prompt entry and cache key, both null when it is not sent to the model. */
export type KeyedCandidate = { candidate: AmbientCandidate; entry: CandidateEntry | null; hash: string | null };

export type LabelStore = Record<string, CachedLabel>;

export function keyCandidates(candidates: AmbientCandidate[], input: ChunkPromptInput, projectsRaw: string): KeyedCandidate[] {
  const entries = new Map(input.candidates.map((entry) => [entry.index, entry]));
  return candidates.map((candidate) => {
    const entry = entries.get(candidate.index) ?? null;
    const hash = entry ? hashCandidate(MODEL, CHUNK_PROMPT, CHUNK_SCHEMA, projectsRaw, input.afk_threshold_minutes, entry) : null;
    return { candidate, entry, hash };
  });
}

/**
 * The day as chunks from whatever labels exist: measured where labelled, honestly
 * unlabelled elsewhere. A candidate that has grown since its last label — the open one, at
 * the end of the day — keeps that label for the stretch it covered, with only the new tail
 * unlabelled, so the screen does not blank a morning's work every time a minute is added.
 */
export function assembleChunks(keyed: KeyedCandidate[], labels: LabelStore, day: AmbientDayMeasure): AmbientChunk[] {
  return keyed.flatMap(({ candidate, hash }) => {
    if (!hash) return [unlabelledChunk(candidate)];
    const exact = labels[hash]?.parts;
    if (exact) return measureChunks(candidate, exact, day);
    const previous = previousVersion(candidate, labels)?.parts;
    if (!previous) return [unlabelledChunk(candidate)];
    const last = previous[previous.length - 1];
    if (new Date(last.to).getTime() >= new Date(candidate.to).getTime()) return measureChunks(candidate, previous, day);
    const tail = measureChunks(candidate, [{ from: last.to, to: candidate.to, label: "", project: OTHER_BUCKET, what: "", evidence: [], unclear: true }], day);
    // A tail too short to be worth a call of its own — the minute or two since a label
    // landed — rides on the part before it. As a card of its own it would read as a fresh
    // unlabelled gap in a stretch that was labelled a moment ago.
    if (tail[0].minutes < MIN_LLM_MIN) return measureChunks(candidate, [...previous.slice(0, -1), { ...last, to: candidate.to }], day);
    return [...measureChunks(candidate, previous, day), ...tail.map((chunk) => ({ ...chunk, label: null }))];
  });
}

/**
 * Candidates showing as unlabelled, in whole or in part, that a call could label: what
 * "Label now" sends, whatever the spend gate says. That is the open stretch at the end of
 * today waiting to grow by half again, and any stretch whose answer was rejected and is
 * waiting out its retries. Sessions and stretches too short for the model are not among
 * them; no call could say anything about those.
 */
export function unlabelledCandidates(keyed: KeyedCandidate[], labels: LabelStore, day: AmbientDayMeasure): KeyedCandidate[] {
  return keyed.filter((item) => item.hash !== null && assembleChunks([item], labels, day).some((chunk) => chunk.label === null));
}

/**
 * Bumped when assembling starts turning the same labels into different chunks, so the stored
 * view the week route and the MCP server read is rebuilt the next time the day is opened
 * rather than kept as the old rule left it. 2: a split may not outweigh its own headline.
 * 3: an open stretch's tail under five minutes rides on the part before it.
 */
const VIEW_VERSION = 3;

/** Identifies the assembled view: the candidate keys in order, plus the sessions, which have no key but do appear in the chunks. */
export function chunksKey(keyed: KeyedCandidate[]): string {
  const hash = createHash("sha256");
  hash.update(`view ${VIEW_VERSION}\n`);
  for (const { candidate, hash: key } of keyed) {
    hash.update(key ?? JSON.stringify({ from: candidate.from, to: candidate.to, manual: candidate.manual ?? null }));
    hash.update("\n");
  }
  return hash.digest("hex");
}

/** Candidates with no label at all, not even an earlier version's: for the screen to count, not for the spend gate. */
export function pendingCount(keyed: KeyedCandidate[], labels: LabelStore): number {
  return keyed.filter(({ candidate, hash }) => hash !== null && !labels[hash]?.parts && !previousVersion(candidate, labels)).length;
}

function wantsCall(label: CachedLabel | undefined, nowMs: number): boolean {
  if (!label) return true;
  if (label.parts) return false;
  return label.attempts < MAX_ATTEMPTS && nowMs - new Date(label.generatedAt).getTime() >= RETRY_AFTER_MS;
}

/** The newest label whose parts open where this candidate opens: the previous version of an open candidate. */
function previousVersion(candidate: AmbientCandidate, labels: LabelStore): CachedLabel | null {
  let best: CachedLabel | null = null;
  for (const label of Object.values(labels)) {
    if (!label.parts || label.parts[0].from !== candidate.from) continue;
    if (!best || label.generatedAt > best.generatedAt) best = label;
  }
  return best;
}

/** Tracked minutes of the candidate falling after `sinceIso`, pro-rated over its span. */
function minutesAfter(candidate: AmbientCandidate, sinceIso: string): number {
  const from = new Date(candidate.from).getTime();
  const to = new Date(candidate.to).getTime();
  const since = new Date(sinceIso).getTime();
  if (to <= from || since <= from) return candidate.minutes;
  if (since >= to) return 0;
  return candidate.minutes * ((to - since) / (to - from));
}

/**
 * The spend gate. A closed candidate with no usable label is due at once: its input will
 * never change, so the call is paid exactly once. The open candidate — the last of the day
 * — is due only when it has grown enough past its last label to be worth another look.
 */
export function dueCandidates(keyed: KeyedCandidate[], labels: LabelStore, nowMs: number): KeyedCandidate[] {
  const due: KeyedCandidate[] = [];
  keyed.forEach((item, position) => {
    if (item.hash === null || !wantsCall(labels[item.hash], nowMs)) return;
    if (position < keyed.length - 1) {
      due.push(item);
      return;
    }
    const previous = previousVersion(item.candidate, labels);
    const lastTo = previous?.parts ? previous.parts[previous.parts.length - 1].to : item.candidate.from;
    const uncovered = minutesAfter(item.candidate, lastTo);
    const covered = item.candidate.minutes - uncovered;
    if (uncovered >= Math.max(UNLABELLED_TAIL_MINUTES, OPEN_RELABEL_FRACTION * covered)) due.push(item);
  });
  return due;
}

/** Already-labelled stretches before the first target, for the partial call to stay consistent with. */
export function earlierToday(keyed: KeyedCandidate[], labels: LabelStore, targets: KeyedCandidate[]): ChunkPromptInput["earlier_today"] {
  const firstTarget = Math.min(...targets.map((t) => keyed.indexOf(t)));
  const earlier: NonNullable<ChunkPromptInput["earlier_today"]> = [];
  keyed.slice(0, firstTarget).forEach(({ hash }) => {
    const parts = hash ? labels[hash]?.parts : null;
    if (parts) earlier.push(...parts.map((p) => ({ from: p.from, to: p.to, project: p.project, what: p.what })));
  });
  return earlier;
}

/**
 * Drops labels for candidates that no longer exist. Today keeps one stale version per
 * open candidate as well — the newest — so the gate can tell how far it has grown since.
 */
export function pruneLabels(labels: LabelStore, keyed: KeyedCandidate[], isToday: boolean): LabelStore {
  const keep = new Set<string>();
  for (const { hash } of keyed) if (hash) keep.add(hash);
  if (isToday) {
    for (const { candidate, hash } of keyed) {
      if (!hash || labels[hash]?.parts) continue;
      const previous = previousVersion(candidate, labels);
      if (!previous) continue;
      for (const [key, label] of Object.entries(labels)) if (label === previous) keep.add(key);
    }
  }
  return Object.fromEntries(Object.entries(labels).filter(([key]) => keep.has(key)));
}

/**
 * Labels from the previous cache shape, for closed days: a version 3 file holds one whole-day
 * answer whose chunks still tile the same candidates. Reused only when they tile a candidate
 * exactly, so nothing is claimed for a stretch that has been cut differently since.
 */
export function salvageLegacy(legacy: LegacyCachedChunks, keyed: KeyedCandidate[]): LabelStore {
  const labels: LabelStore = {};
  for (const { candidate, hash } of keyed) {
    if (!hash) continue;
    const chunks = legacy.chunks.filter((c) => c.candidate === candidate.index && c.label !== null);
    if (chunks.length === 0 || chunks[0].from !== candidate.from || chunks[chunks.length - 1].to !== candidate.to) continue;
    if (chunks.some((c, i) => i > 0 && c.from !== chunks[i - 1].to)) continue;
    labels[hash] = {
      parts: chunks.map((c) => ({ from: c.from, to: c.to, label: c.label as string, project: c.project, what: c.what, evidence: c.evidence, unclear: c.unclear })),
      generatedAt: new Date().toISOString(),
      model: MODEL,
      attempts: 0,
    };
  }
  return labels;
}

export function estimateUsd(usage: Anthropic.Messages.Usage): number {
  return (
    (usage.input_tokens * USD_PER_MTOK.input +
      usage.output_tokens * USD_PER_MTOK.output +
      (usage.cache_read_input_tokens ?? 0) * USD_PER_MTOK.cacheRead +
      (usage.cache_creation_input_tokens ?? 0) * USD_PER_MTOK.cacheWrite) /
    1_000_000
  );
}

export function addUsage(total: AmbientLabelUsage, usage: Anthropic.Messages.Usage): AmbientLabelUsage {
  return {
    calls: total.calls + 1,
    input_tokens: total.input_tokens + usage.input_tokens,
    output_tokens: total.output_tokens + usage.output_tokens,
    cache_read_input_tokens: total.cache_read_input_tokens + (usage.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens: total.cache_creation_input_tokens + (usage.cache_creation_input_tokens ?? 0),
    estimated_usd: total.estimated_usd + estimateUsd(usage),
  };
}

type ModelOutput = { candidates?: { index: number; parts: ChunkPart[] }[] };

export type LabelResult = { labels: LabelStore; call: CachedCall; usage: Anthropic.Messages.Usage };

/**
 * One call for the given candidates only. Returns null when the model gave nothing
 * readable, so nothing is recorded and the next tick may try again; a readable answer that
 * fails validation is recorded as a rejection against that candidate's key.
 */
export async function labelCandidates(
  apiKey: string,
  date: string,
  input: ChunkPromptInput,
  targets: KeyedCandidate[],
  projectKeys: Set<string>,
  previous: LabelStore,
): Promise<LabelResult | null> {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: CHUNK_PROMPT,
    output_config: { format: { type: "json_schema", schema: CHUNK_SCHEMA } },
    messages: [{ role: "user", content: JSON.stringify(input) }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") return null;
  let parsed: ModelOutput;
  try {
    parsed = JSON.parse(textBlock.text) as ModelOutput;
  } catch {
    return null;
  }
  const byIndex = new Map((parsed.candidates ?? []).map((entry) => [entry.index, entry.parts ?? []]));
  const generatedAt = new Date().toISOString();

  const labels: LabelStore = {};
  for (const { candidate, hash } of targets) {
    if (!hash) continue;
    const returned = byIndex.get(candidate.index) ?? [];
    const parts = validateParts(candidate, returned, projectKeys);
    if (parts) {
      labels[hash] = { parts, generatedAt, model: MODEL, attempts: 0 };
      continue;
    }
    // Worth a line in the server log: a rejected answer is the one thing that makes a
    // whole stretch of the day go unlabelled, and the reason is only visible here.
    console.warn(
      `[ambient] ${date} candidate ${candidate.index}: model parts rejected`,
      JSON.stringify(returned.map((p) => ({ from: p.from, to: p.to, project: p.project }))),
      "blocks:",
      JSON.stringify(candidate.blocks.map((b) => [b.from, b.to])),
    );
    labels[hash] = { parts: null, generatedAt, model: MODEL, attempts: (previous[hash]?.attempts ?? 0) + 1 };
  }

  const call: CachedCall = {
    at: generatedAt,
    candidates: targets.length,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    estimated_usd: estimateUsd(response.usage),
  };
  return { labels, call, usage: response.usage };
}
