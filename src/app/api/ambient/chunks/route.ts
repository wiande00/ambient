import { NextResponse } from "next/server";
import { buildCandidates, projectTotals, toChunkInput, type ChunkPromptInput } from "@/lib/ambient/chunks";
import type { AmbientDayMeasure } from "@/lib/ambient/intervals";
import type { AmbientChunksResponse } from "@/lib/ambient/types";
import { EMPTY_USAGE, MAX_CALLS_KEPT, readChunkCache, updateChunkCache, type CachedChunks } from "../chunkCache";
import { loadConfig } from "../config";
import { loadDay, withEdits } from "../days";
import {
  addUsage,
  assembleChunks,
  chunksKey,
  dueCandidates,
  earlierToday,
  keyCandidates,
  labelCandidates,
  MODEL,
  pendingCount,
  pruneLabels,
  salvageLegacy,
  unlabelledCandidates,
  type KeyedCandidate,
  type LabelStore,
} from "../labelling";
import { loadProjects } from "../projects";
import { isValidDateStamp, todayStamp } from "../store";

export const runtime = "nodejs";

/**
 * The day's chunks, labelled. Labels are cached per candidate under a hash of exactly what
 * the model was shown for it (`labelling.ts`), so a closed stretch is paid for once and any
 * edit to the prompt or the projects self-invalidates. Every request assembles the day from
 * the labels it has and answers at once; only candidates without a usable label go to the
 * model, in the background, when the spend gate says they are worth it. Today's log grows
 * all day, so its open stretch is re-labelled now and then, less often as it grows; the
 * screen keeps one shape instead of flipping while being watched. Anyone who would rather
 * not wait for that can ask: `POST` labels whatever is still unlabelled, at once.
 *
 * The model always labels the day as the collector saw it. The person's edits are laid
 * over the result on the way out (`days.ts` `withEdits`), so a correction costs no call and
 * the cache holds only what the model said.
 */

/** The call running for each date, so a burst of reloads starts one call and "Label now" can wait its turn. */
const inFlight = new Map<string, Promise<LabelOutcome>>();

export async function GET(request: Request) {
  const url = new URL(request.url);
  const requested = url.searchParams.get("date");
  if (requested !== null && !isValidDateStamp(requested)) {
    return NextResponse.json({ status: "error", message: "Invalid date." } satisfies AmbientChunksResponse, { status: 400 });
  }
  // `close=1` waits for the call instead of leaving it in the background, so whoever asked
  // knows the day is finished when the answer comes back and can move on to the next one
  // rather than starting every outstanding day at once. The shell's closing pass uses it.
  return respond(requested ?? todayStamp(), url.searchParams.get("close") === "1" ? "close" : "tick");
}

/**
 * "Label now": every stretch of the day still showing as unlabelled goes to the model at
 * once, whatever the spend gate says, and the answer comes back once it has landed. The
 * gate is there so nobody pays for a label every few minutes; the person asking for one is
 * reason enough to pay for it. Body: `{ date }`.
 */
export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const date = body && typeof body === "object" && "date" in body ? body.date : null;
  if (typeof date !== "string" || !isValidDateStamp(date)) {
    return NextResponse.json({ status: "error", message: "Invalid date." } satisfies AmbientChunksResponse, { status: 400 });
  }
  return respond(date, "force");
}

/**
 * `tick` is the dashboard's poll: answer at once, call in the background when the gate says
 * so. `close` waits for that call. `force` waits for a call on everything unlabelled.
 */
type Mode = "tick" | "close" | "force";

async function respond(date: string, mode: Mode): Promise<NextResponse> {
  try {
    const { config } = await loadConfig();
    const apiKey = config.anthropicApiKey;
    const [day, projects] = await Promise.all([loadDay(date, config.afkSeconds), loadProjects()]);
    if (!day || day.measure.intervals.length === 0) {
      return NextResponse.json({ status: "empty", date } satisfies AmbientChunksResponse);
    }

    const { candidates } = buildCandidates(day.measure, config.breakMinutes);
    const input = toChunkInput(candidates, projects.file.projects, config.afkSeconds);
    const keyed = keyCandidates(candidates, input, projects.raw);
    const projectKeys = new Set(projects.file.projects.map((p) => p.key));
    const isToday = date === todayStamp();
    const cached = await readChunkCache(date);

    // A version 3 file holds one whole-day answer; on a closed day its labels are still good.
    let labels: LabelStore = cached?.version === 4 ? cached.labels : cached && !isToday ? salvageLegacy(cached, keyed) : {};
    const salvaged = cached !== null && cached.version !== 4 && Object.keys(labels).length > 0;
    let usage = cached?.version === 4 ? cached.usage : null;
    let calledNow = false;

    if (mode === "force") {
      if (!apiKey) return NextResponse.json({ status: "not_configured" } satisfies AmbientChunksResponse);
      // A call already under way may be labelling the very stretch asked about. Wait for it
      // and look again at the day it leaves, rather than paying twice for the same answer.
      const running = inFlight.get(date);
      if (running) {
        await running;
        return respond(date, mode);
      }
    }

    const due = mode === "force" ? unlabelledCandidates(keyed, labels, day.measure) : dueCandidates(keyed, labels, Date.now());
    if (due.length > 0 && apiKey && !inFlight.has(date)) {
      const job = { apiKey, date, day: day.measure, keyed, input, due, labels, projectKeys, isToday };
      if (cached === null || mode !== "tick") {
        // First look at a day: there is nothing to show yet, so label before answering. The
        // same when whoever asked is waiting for exactly this call.
        const outcome = await runLabelling(job);
        if ("failed" in outcome) {
          // Only the person who asked needs to hear it; a closing pass or a first look
          // answers with what there is, and a later tick tries again.
          if (mode === "force") return NextResponse.json({ status: "error", message: outcome.failed } satisfies AmbientChunksResponse);
        } else {
          labels = outcome.cache.labels;
          usage = outcome.cache.usage;
          calledNow = true;
        }
      } else {
        void runLabelling(job);
      }
    }

    const chunks = withEdits(assembleChunks(keyed, labels, day.measure), day, config.breakMinutes);
    const pending = pendingCount(keyed, labels);

    // Checked after assembling, so a day already labelled renders with no key at all, and
    // neither does a day the person has said something about themselves.
    if (!apiKey && pending > 0 && Object.keys(labels).length === 0 && day.edits.length === 0) {
      return NextResponse.json({ status: "not_configured" } satisfies AmbientChunksResponse);
    }

    // The stored view feeds the week route and the MCP server; keep it current when the
    // day has moved on without a call — a session flipped, a stretch grown, labels salvaged.
    const key = chunksKey(keyed);
    if (!calledNow && (salvaged || (cached?.version === 4 && cached.chunksKey !== key))) {
      const fresh = labels;
      await updateChunkCache(date, (current) => {
        const base = current?.version === 4 ? current : null;
        const merged = base ? base.labels : fresh;
        return {
          version: 4,
          generatedAt: base?.generatedAt ?? new Date().toISOString(),
          model: MODEL,
          chunksKey: key,
          chunks: assembleChunks(keyed, merged, day.measure),
          labels: merged,
          usage: base?.usage ?? EMPTY_USAGE,
          calls: base?.calls ?? [],
        };
      });
    }

    return NextResponse.json({
      status: "ready",
      date,
      chunks,
      projects: projectTotals(chunks),
      cached: !calledNow,
      pending,
      unlabelled: apiKey
        ? unlabelledCandidates(keyed, labels, day.measure).map(({ candidate }) => ({ from: candidate.from, to: candidate.to }))
        : [],
      usage,
      projectsError: projects.error,
      projectNames: Object.fromEntries(projects.file.projects.map((p) => [p.key, p.name])),
    } satisfies AmbientChunksResponse);
  } catch (error) {
    return NextResponse.json({
      status: "error",
      message: error instanceof Error ? error.message : "Chunks failed to generate.",
    } satisfies AmbientChunksResponse);
  }
}

type LabelJob = {
  apiKey: string;
  date: string;
  day: AmbientDayMeasure;
  keyed: KeyedCandidate[];
  input: ChunkPromptInput;
  due: KeyedCandidate[];
  labels: LabelStore;
  projectKeys: Set<string>;
  isToday: boolean;
};

/** The day's cache after a call, or why there was nothing to merge. */
type LabelOutcome = { cache: CachedChunks } | { failed: string };

/**
 * One call for the due candidates, merged into the day's cache as it is on disk at the
 * moment the answer lands. Fails when the model gave nothing readable or the call itself
 * failed; either way the next tick may try again.
 */
function runLabelling(job: LabelJob): Promise<LabelOutcome> {
  const run = callAndMerge(job);
  inFlight.set(job.date, run);
  return run.finally(() => {
    if (inFlight.get(job.date) === run) inFlight.delete(job.date);
  });
}

async function callAndMerge(job: LabelJob): Promise<LabelOutcome> {
  const { apiKey, date, day, keyed, input, due, labels, projectKeys, isToday } = job;
  try {
    const partial: ChunkPromptInput = {
      ...input,
      candidates: due.flatMap((t) => (t.entry ? [t.entry] : [])),
      earlier_today: earlierToday(keyed, labels, due),
    };
    const result = await labelCandidates(apiKey, date, partial, due, projectKeys, labels);
    if (!result) return { failed: "The model's answer could not be read." };

    const updated = await updateChunkCache(date, (current) => {
      const base = current?.version === 4 ? current : null;
      const merged = pruneLabels({ ...(base?.labels ?? labels), ...result.labels }, keyed, isToday);
      return {
        version: 4,
        generatedAt: result.call.at,
        model: MODEL,
        chunksKey: chunksKey(keyed),
        chunks: assembleChunks(keyed, merged, day),
        labels: merged,
        usage: addUsage(base?.usage ?? EMPTY_USAGE, result.usage),
        calls: [...(base?.calls ?? []), result.call].slice(-MAX_CALLS_KEPT),
      };
    });

    const indices = due.map((t) => t.candidate.index).join(", ");
    const dayUsd = updated ? updated.usage.estimated_usd : result.call.estimated_usd;
    console.log(
      `[ambient] ${date} labelled ${due.length} candidate(s) [idx ${indices}] in=${result.call.input_tokens} out=${result.call.output_tokens} $${result.call.estimated_usd.toFixed(4)} (day $${dayUsd.toFixed(4)})`,
    );
    return updated ? { cache: updated } : { failed: "The labels could not be saved." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[ambient] ${date} labelling failed:`, message);
    return { failed: message };
  }
}
