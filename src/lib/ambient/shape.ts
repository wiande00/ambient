import type { AmbientDaySegment } from "./chunks";
import { overlapMs } from "./idle";
import { round1, type AmbientDayMeasure, type AmbientDayTotals, type ClockRange } from "./intervals";

/**
 * The shape of a working day: when it started and ended, the breaks inside it, and how much
 * of it was worked — figures that compare from one day to the next whether or not the
 * machine was left on.
 *
 * Idle as measured mixes three things. A few minutes reading a reply is part of working. A
 * lunch is a break. A computer left on all evening, or all night, with nobody at it is
 * neither — it is whether the machine happened to be switched off, and on a day it was not,
 * it buried every other figure. So an idle stretch at least `LEFT_ON_MINUTES` long is read
 * here as *left on*: out of the idle and tracked totals, drawn as time nobody was there.
 *
 * Read only, on the way out. The day is measured, cut and labelled exactly as before — an
 * idle stretch this long already ends a stretch of work as a break — so nothing here can
 * move a boundary or a label.
 */

/** An idle stretch at least this long means nobody was there: the machine was left on. */
export const LEFT_ON_MINUTES = 60;

/**
 * The left-on threshold for a given *Break after* setting. Never below the break threshold:
 * a left-on stretch must always be a break already, or reading it as one would cut a
 * stretch of work the day was not cut at.
 */
export function leftOnThreshold(breakMinutes: number): number {
  return Math.max(LEFT_ON_MINUTES, breakMinutes);
}

/** The day's idle stretches long enough to count as left on, ascending. */
export function leftOnRanges(day: AmbientDayMeasure, thresholdMinutes: number): ClockRange[] {
  return day.idle.filter((run) => run.endMs - run.startMs >= thresholdMinutes * 60_000);
}

export type AmbientShapedTotals = AmbientDayTotals & {
  /** Idle minutes in stretches long enough that nobody was there; not in `idleMinutes` or `trackedMinutes`. */
  leftOnMinutes: number;
};

/** The day's totals with left-on time taken out of idle and tracked, and given its own figure. */
export function withoutLeftOn(day: AmbientDayMeasure, ranges: ClockRange[]): AmbientShapedTotals {
  let leftOnMs = 0;
  for (const iv of day.intervals) {
    if (iv.manual) continue;
    leftOnMs += Math.min(iv.idleMs, overlapMs(iv.startMs, iv.endMs, ranges));
  }
  const leftOn = round1(leftOnMs / 60_000);
  return {
    ...day.totals,
    trackedMinutes: round1(Math.max(0, day.totals.trackedMinutes - leftOn)),
    idleMinutes: round1(Math.max(0, day.totals.idleMinutes - leftOn)),
    leftOnMinutes: leftOn,
  };
}

/** The day's cut with each break that was mostly left-on time marked as such, for the list and the band to draw as time nobody was there. */
export function markLeftOn(segments: AmbientDaySegment[], ranges: ClockRange[]): AmbientDaySegment[] {
  if (ranges.length === 0) return segments;
  return segments.map((segment) => {
    if (segment.kind !== "break") return segment;
    const fromMs = Date.parse(segment.from);
    const toMs = Date.parse(segment.to);
    return overlapMs(fromMs, toMs, ranges) * 2 >= toMs - fromMs ? { ...segment, leftOn: true } : segment;
  });
}

export type AmbientDayShape = {
  /** From the start of the first stretch of work to the end of the last; null on a day with none. */
  span: { from: string; to: string; minutes: number } | null;
  /** The gaps between stretches shorter than the left-on threshold: lunch, a walk, a call away from the desk. */
  breaks: { count: number; minutes: number };
  /** Active minutes as a share of the span, 0–1: how compressed the day was. */
  density: number | null;
};

/** A stretch shorter than this does not open or close the day: a window that flashed up as the machine woke. */
const MIN_STRETCH_MINUTES = 1;

/**
 * Span, breaks and density from the day's cut. A gap between two stretches — however the
 * machine spent it: idle, locked, asleep — is a break when shorter than the left-on
 * threshold, and time away otherwise. A stretch the person removed is neither.
 */
export function dayShape(segments: AmbientDaySegment[], activeMinutes: number, thresholdMinutes: number): AmbientDayShape {
  const isStretch = (segment: AmbientDaySegment) => segment.kind === "candidate" && segment.minutes >= MIN_STRETCH_MINUTES;
  const first = segments.findIndex(isStretch);
  if (first === -1) return { span: null, breaks: { count: 0, minutes: 0 }, density: null };
  let last = first;
  segments.forEach((segment, index) => {
    if (isStretch(segment)) last = index;
  });

  let count = 0;
  let breakMinutes = 0;
  let gap = 0;
  let leftOn = false;
  const closeGap = () => {
    if (gap > 0 && !leftOn && gap < thresholdMinutes) {
      count++;
      breakMinutes += gap;
    }
    gap = 0;
    leftOn = false;
  };
  for (let i = first + 1; i <= last; i++) {
    const segment = segments[i];
    if (segment.kind === "candidate") {
      closeGap();
      continue;
    }
    if (segment.kind === "away" && segment.why === "removed") continue;
    gap += segment.minutes;
    if (segment.kind === "break" && segment.leftOn) leftOn = true;
  }
  closeGap();

  const from = segments[first].from;
  const to = segments[last].to;
  const spanMinutes = round1((Date.parse(to) - Date.parse(from)) / 60_000);
  return {
    span: { from, to, minutes: spanMinutes },
    breaks: { count, minutes: round1(breakMinutes) },
    density: spanMinutes > 0 ? Math.min(1, Math.round((activeMinutes / spanMinutes) * 100) / 100) : null,
  };
}
