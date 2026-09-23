import type { AmbientLog, AmbientSample } from "./rollup";

/**
 * The idle rule.
 *
 * A person is active from an input event until the threshold passes with no input at all;
 * then the whole stretch since that last input is idle, up to the next input. This is the
 * rule every desktop time tracker uses, and it is what makes reading a page for three
 * minutes count as work while a tab left open for half an hour does not. The collector
 * records every run of no input at least its own (much lower) floor long; the threshold is
 * applied here, so it can change without recollecting a single day.
 *
 * The threshold is a parameter everywhere, never a module constant: it comes from the
 * settings file on each request, so a change on the Settings screen is live on the next
 * fetch with no restart.
 *
 * Logs from before the collector wrote idle runs (format 1) only know how many seconds of a
 * block had *any* input. For those, idle is estimated per block on the assumption that the
 * block's input-free seconds formed one run — the first threshold's worth of that run
 * counts as active, the rest as idle. Every figure derived that way is flagged `estimated`
 * all the way up to the screen.
 */

/** Seconds without input after which the stretch since the last input is idle, unless settings say otherwise. */
export const DEFAULT_AFK_THRESHOLD_S = 300;

export type IdleInterval = { startMs: number; endMs: number };

/** Every recorded idle run that meets the threshold, as absolute intervals, ascending. */
export function idleIntervals(log: AmbientLog, thresholdS: number): IdleInterval[] {
  return log.idle
    .filter((run) => run.s >= thresholdS)
    .map((run) => {
      const startMs = new Date(run.t).getTime();
      return { startMs, endMs: startMs + run.s * 1000 };
    })
    .filter((run) => Number.isFinite(run.startMs))
    .sort((a, b) => a.startMs - b.startMs);
}

/**
 * Idle seconds inside one format-1 block. A block shorter than the threshold can never be
 * idle under the rule; a longer one is idle for whatever its no-input seconds exceed the
 * threshold by. A block with no `active_s` at all predates input tracking and is taken as
 * fully active, the same reading `rollUp` gives it.
 */
export function estimatedIdleSeconds(sample: AmbientSample, thresholdS: number): number {
  if (sample.dwell_s < thresholdS) return 0;
  const active = Math.max(0, Math.min(sample.active_s ?? sample.dwell_s, sample.dwell_s));
  return Math.max(0, sample.dwell_s - active - thresholdS);
}

/** Milliseconds of `[startMs, endMs)` covered by any of `runs`. Runs are assumed non-overlapping. */
export function overlapMs(startMs: number, endMs: number, runs: IdleInterval[]): number {
  let total = 0;
  for (const run of runs) {
    if (run.endMs <= startMs) continue;
    if (run.startMs >= endMs) break;
    total += Math.min(endMs, run.endMs) - Math.max(startMs, run.startMs);
  }
  return total;
}
