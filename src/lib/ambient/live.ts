import { toSample, type AmbientLog, type AmbientSample } from "./rollup";

/**
 * What the collector has seen but not yet written to the log.
 *
 * The log only gets a block once focus moves on, so the window in front right now — often
 * the one being worked in for the last hour — is not in it. Neither is an idle run still in
 * progress, which is written when input resumes. Left at that, the day's figures stood
 * still for as long as someone stayed in one window and jumped the moment they switched,
 * and switching to the dashboard to look is itself a switch: the numbers only ever looked
 * current once the window was clicked.
 *
 * So the collector keeps `~/.ambient/live.json` beside the log: the open block exactly as
 * it would be written if it closed now, and when the last input was. Folding it in here
 * makes today's measure include the present. It is provisional by nature and treated so:
 * a snapshot that has gone stale (a collector that died without flushing) is ignored, and
 * once the block or the idle run reaches the log the logged line wins.
 */

/** A snapshot older than this is from a collector that is no longer writing. It rewrites every 15 s. */
export const LIVE_STALE_MS = 60_000;

export type AmbientLive = {
  /** When the collector wrote this, UTC. */
  observed: string;
  /** The open focus block as of `observed`, in the log's own shape. Absent while locked or with no window in front. */
  block: AmbientSample | null;
  /** The last input event, UTC: everything from here to `observed` is an idle run in progress. */
  idleSince: string | null;
};

/** The file's JSON, or `null` when it is not a snapshot this reader understands. */
export function parseLive(raw: string): AmbientLive | null {
  try {
    const parsed = JSON.parse(raw.replace(/^﻿/, "")) as { v?: unknown; observed?: unknown; block?: unknown; idle_since?: unknown };
    if (parsed.v !== 1 || typeof parsed.observed !== "string" || !Number.isFinite(Date.parse(parsed.observed))) return null;
    return {
      observed: parsed.observed,
      block: toSample(parsed.block),
      idleSince: typeof parsed.idle_since === "string" && Number.isFinite(Date.parse(parsed.idle_since)) ? parsed.idle_since : null,
    };
  } catch {
    // Read mid-write, or hand-edited: no snapshot this time, the next one is seconds away.
    return null;
  }
}

/**
 * The log with the live snapshot folded in. A new object; the parsed log is left as it was,
 * since it is cached and shared. Nothing is added when the snapshot is stale, and neither
 * half is added once the log already holds it — the collector appends the closed block and
 * only then rewrites the snapshot, so for a moment both describe the same block.
 */
export function withLive(log: AmbientLog, live: AmbientLive | null, nowMs: number): AmbientLog {
  if (!live) return log;
  const observedMs = Date.parse(live.observed);
  if (nowMs - observedMs > LIVE_STALE_MS) return log;

  const block = live.block;
  const logged = block !== null && log.samples.some((sample) => sample.t === block.t && sample.app === block.app);
  const samples = block && !logged ? [...log.samples, block] : log.samples;

  let idle = log.idle;
  if (live.idleSince !== null) {
    const startMs = Date.parse(live.idleSince);
    const s = Math.floor((observedMs - startMs) / 1000);
    // The run's closing line, once written, starts where this one does; overlap is the
    // test rather than equal strings, because the collector re-reads the last input time
    // every tick and the two can land a second apart.
    const overlaps = log.idle.some((run) => {
      const runStartMs = Date.parse(run.t);
      return runStartMs < observedMs && runStartMs + run.s * 1000 > startMs;
    });
    if (s > 0 && !overlaps) idle = [...log.idle, { t: live.idleSince, s }];
  }

  if (samples === log.samples && idle === log.idle) return log;
  return { ...log, samples, idle };
}
