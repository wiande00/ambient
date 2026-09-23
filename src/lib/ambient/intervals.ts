import { estimatedIdleSeconds, idleIntervals, overlapMs, type IdleInterval } from "./idle";
import { OFF_COMPUTER_APP, subtractRanges, type ManualRange } from "./offComputer";
import type { AmbientContentSnapshot, AmbientLog, AmbientSample } from "./rollup";

/**
 * One day, measured. Every figure here is arithmetic over what the collector wrote: which
 * window was in front and for how long, when there was no input, when nobody was at the
 * machine at all. No model, no I/O, no judgement — the same log always measures the same.
 *
 * This is the single source for everything drawn or totalled about a day: the band, the
 * headline figures, the candidates the model later labels. The digest in `rollup.ts` used to
 * play that role for the model and `timeline.ts` for the band, and the two disagreed about
 * block boundaries. They read from here now.
 */

/** A gap this small or smaller is collector clock jitter between per-change writes, not a real gap. */
const CONTIGUITY_EPSILON_S = 5;
/** Titles carried on an interval, longest-held first. Enough to identify the work, not enough to become a log. */
const MAX_TITLES = 4;

export type AmbientInterval = {
  startMs: number;
  endMs: number;
  app: string;
  /** Distinct window titles inside this interval, longest-held first, capped. */
  titles: string[];
  /** Milliseconds counted as worked under the idle rule. `dwell − idle`. */
  activeMs: number;
  /** Milliseconds counted as idle under the idle rule — see `idle.ts`. */
  idleMs: number;
  /** True when `idleMs` was estimated from a format-1 block rather than read from recorded runs. */
  estimated: boolean;
  /** Screen-content extractions taken during this interval, chronological. Kept raw; shaping is the reader's job. */
  contents?: AmbientContentSnapshot[];
  /** Set when this is a "working off the computer" session rather than a window: fully active, already assigned. */
  manual?: { project: string; note: string };
};

export type AmbientAwayKind = "lock" | "sleep" | "unobserved" | "removed";

export type AmbientAway = {
  startMs: number;
  endMs: number;
  /**
   * `lock` and `sleep` come from the collector; `removed` is a stretch the person took out
   * of the day (`edits.ts`); `unobserved` is a hole between blocks nothing explains.
   */
  why: AmbientAwayKind;
};

/** A stretch of the clock, in ms. */
export type ClockRange = { startMs: number; endMs: number };

export type AmbientDayTotals = {
  trackedMinutes: number;
  activeMinutes: number;
  idleMinutes: number;
  /** Minutes between the first and last observed moment that no block covers, less any the person removed. */
  awayMinutes: number;
  /** True when any idle figure in the day came from the format-1 estimate. */
  estimatedIdle: boolean;
};

export type AmbientDayMeasure = {
  date: string;
  /** First and last observed instants of the day, in ms. Equal when nothing was observed. */
  firstMs: number;
  lastMs: number;
  intervals: AmbientInterval[];
  /** Every idle run that met the threshold, positioned and clipped to the day, ascending. Estimated ones sit at their interval's tail. */
  idle: IdleInterval[];
  away: AmbientAway[];
  /** Stretches the person took out of the day, ascending. Nothing is measured inside them. */
  removed: ClockRange[];
  totals: AmbientDayTotals;
  /** Which log format the day was read in. 2 means idle runs were recorded. */
  format: 1 | 2;
};

/**
 * Measures one calendar day from its log. Everything is clipped to the local day: the
 * collector re-derives the log path per poll, so a block that started before midnight is
 * written into the next day's file with the previous day's `t`, and reading it unclipped
 * stretched a band back to the previous evening.
 *
 * `manual` are the day's "working off the computer" sessions, and the stretches the person
 * has since said were worked, already clipped to it. Each is trusted over the screen:
 * inside one, the idle runs are masked (nobody typed because they were writing on paper),
 * the windows that happened to be in front are cut out, and the stretch stands as one
 * fully active interval of its own. `removed` are stretches the person took out of the
 * day: cut out the same way, with nothing put in their place.
 */
export function measureDay(
  date: string,
  log: AmbientLog,
  thresholdS: number,
  manual: ManualRange[] = [],
  removed: ClockRange[] = [],
): AmbientDayMeasure {
  const [y, m, d] = date.split("-").map(Number);
  const dayStartMs = new Date(y, m - 1, d).getTime();
  const dayEndMs = new Date(y, m - 1, d + 1).getTime();

  const masks = unionRanges([...manual, ...removed]);
  const idle = idleIntervals(log, thresholdS).flatMap((run) => subtractRanges(run.startMs, run.endMs, masks));
  // Samples written before the first `start` line of a v2 run carry no idle runs; they get
  // the estimate the same as a format-1 log would.
  const recordedFromMs = log.format === 2 ? earliest(log.startedAt) : Number.POSITIVE_INFINITY;

  const samples = [...log.samples]
    .map((sample) => clipSample(sample, dayStartMs, dayEndMs))
    .filter((sample): sample is AmbientSample => sample !== null)
    .sort((a, b) => a.t.localeCompare(b.t));

  const screen: AmbientInterval[] = [];
  // Title dwell per interval, parallel to `screen`, so a merged interval can re-rank.
  const weights: Map<string, number>[] = [];
  for (const sample of samples) {
    const startMs = new Date(sample.t).getTime();
    const endMs = startMs + sample.dwell_s * 1000;
    const estimated = startMs < recordedFromMs;
    const idleMs = estimated
      ? Math.min(sample.dwell_s, estimatedIdleSeconds(sample, thresholdS)) * 1000
      : Math.min(endMs - startMs, overlapMs(startMs, endMs, idle));

    const last = screen[screen.length - 1];
    // Merge adjacent same-app samples separated only by jitter — the collector writes one
    // sample per change, so a restart mid-session can split a window the user never left.
    if (last && last.app === sample.app && (startMs - last.endMs) / 1000 <= CONTIGUITY_EPSILON_S) {
      last.endMs = Math.max(last.endMs, endMs);
      last.idleMs += idleMs;
      last.activeMs = last.endMs - last.startMs - last.idleMs;
      last.estimated = last.estimated || estimated;
      last.titles = rankTitles(addTitle(weights[weights.length - 1], sample.title, sample.dwell_s * 1000));
      if (sample.contents?.length) last.contents = [...(last.contents ?? []), ...sample.contents];
      continue;
    }

    const titleWeights = addTitle(new Map<string, number>(), sample.title, sample.dwell_s * 1000);
    weights.push(titleWeights);
    screen.push({
      startMs,
      endMs,
      app: sample.app,
      titles: rankTitles(titleWeights),
      activeMs: endMs - startMs - idleMs,
      idleMs,
      estimated,
      ...(sample.contents?.length ? { contents: [...sample.contents] } : {}),
    });
  }

  const intervals = masks.length === 0 ? screen : foldManual(screen, manual, masks, idle);

  // The idle runs themselves, positioned, for anything that needs to cut at one — a run
  // long enough to be a break in the day. Recorded runs are clipped to the day; an
  // estimated interval's idle is placed at its tail, which is where a window left open
  // and returned to actually spends it.
  const positionedIdle: IdleInterval[] = [];
  for (const run of idle) {
    const startMs = Math.max(run.startMs, dayStartMs);
    const endMs = Math.min(run.endMs, dayEndMs);
    if (endMs > startMs) positionedIdle.push({ startMs, endMs });
  }
  for (const iv of intervals) {
    if (iv.estimated && iv.idleMs > 0) positionedIdle.push({ startMs: iv.endMs - iv.idleMs, endMs: iv.endMs });
  }
  positionedIdle.sort((a, b) => a.startMs - b.startMs);

  const firstMs = intervals.length > 0 ? intervals[0].startMs : dayStartMs;
  const lastMs = intervals.length > 0 ? Math.max(...intervals.map((iv) => iv.endMs)) : dayStartMs;

  const cutOut = unionRanges(removed);
  const away = awayIntervals(intervals, log, cutOut, dayStartMs, dayEndMs);

  let trackedMs = 0;
  let idleMs = 0;
  let estimatedIdle = false;
  for (const iv of intervals) {
    trackedMs += iv.endMs - iv.startMs;
    idleMs += iv.idleMs;
    estimatedIdle = estimatedIdle || (iv.estimated && iv.idleMs > 0);
  }
  // A removed stretch inside the day is a hole like any other, but the person said it does
  // not count, so it is not counted as away either.
  const awayMs = Math.max(0, lastMs - firstMs - trackedMs - overlapMs(firstMs, lastMs, cutOut));

  return {
    date,
    firstMs,
    lastMs,
    intervals,
    idle: positionedIdle,
    away,
    removed: cutOut,
    totals: {
      trackedMinutes: round1(trackedMs / 60000),
      activeMinutes: round1((trackedMs - idleMs) / 60000),
      idleMinutes: round1(idleMs / 60000),
      awayMinutes: round1(awayMs / 60000),
      estimatedIdle,
    },
    format: log.format,
  };
}

/**
 * Cuts the screen intervals out of the sessions' ranges and puts each session in as one
 * interval of its own. A window that was in front while the person wrote on paper keeps
 * only the part outside the session; the session takes the rest, fully active. `masks` is
 * every range cut out — the sessions and the removed stretches — ascending and disjoint.
 */
function foldManual(screen: AmbientInterval[], manual: ManualRange[], masks: ClockRange[], idle: IdleInterval[]): AmbientInterval[] {
  const out: AmbientInterval[] = [];
  for (const iv of screen) {
    for (const part of subtractRanges(iv.startMs, iv.endMs, masks)) {
      if (part.startMs === iv.startMs && part.endMs === iv.endMs) {
        out.push(iv);
        continue;
      }
      const idleMs = iv.estimated
        ? Math.max(0, Math.min(part.endMs, iv.endMs) - Math.max(part.startMs, iv.endMs - iv.idleMs))
        : overlapMs(part.startMs, part.endMs, idle);
      const contents = (iv.contents ?? []).filter((snap) => {
        const at = new Date(snap.t).getTime();
        return at >= part.startMs && at < part.endMs;
      });
      out.push({
        ...iv,
        startMs: part.startMs,
        endMs: part.endMs,
        idleMs,
        activeMs: part.endMs - part.startMs - idleMs,
        ...(contents.length > 0 ? { contents } : { contents: undefined }),
      });
    }
  }
  for (const range of manual) {
    out.push({
      startMs: range.startMs,
      endMs: range.endMs,
      app: OFF_COMPUTER_APP,
      titles: [range.note || "Working off the computer"],
      activeMs: range.endMs - range.startMs,
      idleMs: 0,
      estimated: false,
      manual: { project: range.project, note: range.note },
    });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Every hole between consecutive intervals larger than jitter, explained by an `away` line
 * or a removed stretch when one covers it and marked unobserved otherwise. Explanations
 * that fall inside a hole name it; they never widen or narrow it, because the hole is what
 * was measured.
 */
function awayIntervals(intervals: AmbientInterval[], log: AmbientLog, removed: ClockRange[], dayStartMs: number, dayEndMs: number): AmbientAway[] {
  const explicit: AmbientAway[] = log.away
    .map((run): AmbientAway => {
      const startMs = new Date(run.t).getTime();
      return { startMs: Math.max(startMs, dayStartMs), endMs: Math.min(startMs + run.s * 1000, dayEndMs), why: run.why };
    })
    .filter((run) => Number.isFinite(run.startMs) && run.endMs > run.startMs);
  explicit.push(...removed.map((range): AmbientAway => ({ ...range, why: "removed" })));

  const out: AmbientAway[] = [];
  for (let i = 1; i < intervals.length; i++) {
    const startMs = intervals[i - 1].endMs;
    const endMs = intervals[i].startMs;
    if ((endMs - startMs) / 1000 <= CONTIGUITY_EPSILON_S) continue;
    // The explanation that covers most of the hole wins; a hole with none is unobserved.
    let why: AmbientAwayKind = "unobserved";
    let bestMs = 0;
    for (const run of explicit) {
      const covered = overlapMs(startMs, endMs, [run]);
      if (covered > bestMs) {
        bestMs = covered;
        why = run.why;
      }
    }
    out.push({ startMs, endMs, why });
  }
  return out;
}

/** The sample clipped to `[dayStartMs, dayEndMs)`, or null when none of it falls inside. */
function clipSample(sample: AmbientSample, dayStartMs: number, dayEndMs: number): AmbientSample | null {
  const startMs = new Date(sample.t).getTime();
  if (!Number.isFinite(startMs)) return null;
  const endMs = startMs + sample.dwell_s * 1000;
  const clippedStart = Math.max(startMs, dayStartMs);
  const clippedEnd = Math.min(endMs, dayEndMs);
  if (clippedEnd <= clippedStart) return null;
  if (clippedStart === startMs && clippedEnd === endMs) return sample;
  const share = (clippedEnd - clippedStart) / (endMs - startMs);
  return {
    ...sample,
    t: new Date(clippedStart).toISOString().replace(/\.\d{3}Z$/, "Z"),
    dwell_s: Math.round((clippedEnd - clippedStart) / 1000),
    active_s: sample.active_s === undefined ? undefined : Math.round(sample.active_s * share),
  };
}

/** Ascending, with overlapping or touching ranges joined. */
export function unionRanges(ranges: ClockRange[]): ClockRange[] {
  const sorted = ranges.filter((range) => range.endMs > range.startMs).sort((a, b) => a.startMs - b.startMs);
  const out: ClockRange[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.startMs <= last.endMs) last.endMs = Math.max(last.endMs, range.endMs);
    else out.push({ startMs: range.startMs, endMs: range.endMs });
  }
  return out;
}

function earliest(stamps: string[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const stamp of stamps) {
    const ms = new Date(stamp).getTime();
    if (Number.isFinite(ms) && ms < best) best = ms;
  }
  return best;
}

/** A blank title carries no signal and is never worth a slot. */
function addTitle(weights: Map<string, number>, title: string, ms: number): Map<string, number> {
  const trimmed = title.trim();
  if (trimmed.length > 0) weights.set(trimmed, (weights.get(trimmed) ?? 0) + ms);
  return weights;
}

/** Longest-held first, capped — the title that characterises the stretch leads. */
function rankTitles(weights: Map<string, number>): string[] {
  return [...weights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TITLES)
    .map(([title]) => title);
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export type { IdleInterval };
