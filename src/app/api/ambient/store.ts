import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChunkPromptInput } from "@/lib/ambient/chunks";
import { parseLive, type AmbientLive } from "@/lib/ambient/live";

/**
 * Filesystem access to the collector's logs, kept out of the route handlers so they read
 * as request/response logic and out of `lib/ambient/` so that stays pure. Everything under
 * `~/.ambient/` lives only on this machine; nothing here makes a network call.
 */

const DATE_STAMP = /^\d{4}-\d{2}-\d{2}$/;

/** The only gate between a request's `?date=` param and a path built from it. */
export function isValidDateStamp(date: string): boolean {
  return DATE_STAMP.test(date);
}

export function ambientDir(): string {
  return join(homedir(), ".ambient");
}

export function logPathFor(date: string): string {
  return join(ambientDir(), `${date}.jsonl`);
}

/** The collector's snapshot of the block it has open, which the log gets only once it closes. See `lib/ambient/live.ts`. */
export function livePath(): string {
  return join(ambientDir(), "live.json");
}

/** That snapshot, or `null` when there is none (no collector, a clean stop) or it could not be read this time. */
export async function readLive(): Promise<AmbientLive | null> {
  try {
    return parseLive(await readFile(livePath(), "utf8"));
  } catch {
    return null;
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Today's local calendar date, e.g. "2026-08-06". Built from local date parts, never
 * `.toISOString()` — that reports the UTC date, which is a day behind the local one for
 * part of the evening depending on offset, while the collector (PowerShell's `Get-Date`,
 * local) is already writing to today's local-dated file.
 */
export function todayStamp(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** Every date with a log file on disk, ascending. A missing directory is just no dates yet, not an error. */
export async function listLogDates(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(ambientDir());
  } catch {
    return [];
  }
  return entries
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .map((name) => name.slice(0, -".jsonl".length))
    .sort();
}

/** Raw JSONL for a date, or `null` if there's no log for it (not started, or deleted). */
export async function readLog(date: string): Promise<string | null> {
  try {
    return await readFile(logPathFor(date), "utf8");
  } catch {
    return null;
  }
}

/**
 * Keys a cache to everything that determines the model's output: the model, the prompt,
 * the schema, and the input. Hashing the model input rather than the raw log means the
 * cache still invalidates whenever the log changes — and it also self-invalidates if the
 * prompt, schema, or model id is ever edited, with no version constant to remember to bump.
 * One consequence worth knowing: editing the prompt invalidates every cached day at once,
 * so the next load of each day pays for one fresh call.
 */
/**
 * The key one candidate's label is cached under: everything that would change the answer
 * — the model, the prompt, the schema, the projects file, the idle threshold, and the
 * candidate's own blocks — and nothing that would not. The index is left out because it
 * shifts whenever an earlier boundary moves; `earlier_today` is context, not content.
 */
export function hashCandidate(
  model: string,
  systemPrompt: string,
  schema: unknown,
  projectsRaw: string,
  afkThresholdMinutes: number,
  entry: ChunkPromptInput["candidates"][number],
): string {
  const { index, ...candidate } = entry;
  void index;
  return hashReadInput(model, systemPrompt, schema, { projects: projectsRaw, afk: afkThresholdMinutes, candidate });
}

export function hashReadInput(model: string, systemPrompt: string, schema: unknown, digest: unknown): string {
  const hash = createHash("sha256");
  hash.update(model);
  hash.update("\n");
  hash.update(systemPrompt);
  hash.update("\n");
  hash.update(JSON.stringify(schema));
  hash.update("\n");
  hash.update(JSON.stringify(digest));
  return hash.digest("hex");
}
