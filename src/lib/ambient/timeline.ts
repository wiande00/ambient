import type { AmbientInterval } from "./intervals";
import { toLocalIso } from "./rollup";

/**
 * The day band's spans, derived from the measured intervals. Rendering only — never sent to
 * the model. Every interval is kept, because a gap here reads visually as "not observed"
 * and dropping a real glance would draw tracked time as untracked.
 *
 * Titles ride along on a span — they are what make a stretch legible as work rather than as
 * an app. Screen content does not; extracted text stays off this surface.
 */

export type AmbientTimelineSpan = {
  from: string;
  to: string;
  kind: "focus" | "burst";
  /** The window's app for `focus`; `"multiple"` for `burst`. */
  app: string;
  /** `burst` only — distinct apps touched, in order of first appearance. */
  apps?: string[];
  /** Distinct window titles inside this span, longest-held first, capped. */
  titles?: string[];
  minutes: number;
  /** Minutes counted as worked under the idle rule. */
  active_minutes: number;
  /** Minutes counted as idle under the idle rule. */
  idle_minutes: number;
};

export type AmbientTimeline = {
  start: string;
  end: string;
  spans: AmbientTimelineSpan[];
};

/** Below this, a run of consecutive short spans becomes one burst span. */
const MIN_SPAN_SECONDS = 30;
/** A gap this small or smaller is collector clock jitter between per-change writes, not a real gap. */
const CONTIGUITY_EPSILON_S = 5;
/** Above this many spans, MIN_SPAN_SECONDS doubles and grouping re-runs, up to this ceiling. */
const MAX_TIMELINE_SPANS = 200;
const MIN_SPAN_SECONDS_CEILING = 3600;
/** Titles carried on a span. Enough to identify the work, not enough to become a log. */
const MAX_TITLES_PER_SPAN = 4;

export function buildTimeline(intervals: AmbientInterval[]): AmbientTimeline | null {
  if (intervals.length === 0) return null;

  let minSpanSeconds = MIN_SPAN_SECONDS;
  let spans = groupIntoSpans(intervals, minSpanSeconds);
  while (spans.length > MAX_TIMELINE_SPANS && minSpanSeconds < MIN_SPAN_SECONDS_CEILING) {
    minSpanSeconds *= 2;
    spans = groupIntoSpans(intervals, minSpanSeconds);
  }

  const start = Math.min(...intervals.map((iv) => iv.startMs));
  const end = Math.max(...intervals.map((iv) => iv.endMs));

  return {
    start: toLocalIso(new Date(start)),
    end: toLocalIso(new Date(end)),
    spans,
  };
}

/**
 * A maximal run of two or more consecutive intervals each shorter than `minSpanSeconds`,
 * with every internal gap within jitter tolerance, collapses into one burst span. A lone
 * short interval is kept as its own focus span rather than dropped. A gap larger than
 * jitter tolerance always ends a run, so grouping never paints over a real gap.
 */
function groupIntoSpans(intervals: AmbientInterval[], minSpanSeconds: number): AmbientTimelineSpan[] {
  const spans: AmbientTimelineSpan[] = [];
  let i = 0;
  while (i < intervals.length) {
    const iv = intervals[i];
    const durationS = (iv.endMs - iv.startMs) / 1000;
    if (durationS >= minSpanSeconds) {
      spans.push(toFocusSpan(iv));
      i++;
      continue;
    }
    let j = i;
    while (j < intervals.length) {
      const cur = intervals[j];
      const shortEnough = (cur.endMs - cur.startMs) / 1000 < minSpanSeconds;
      if (!shortEnough) break;
      if (j > i) {
        const gapS = (cur.startMs - intervals[j - 1].endMs) / 1000;
        if (gapS > CONTIGUITY_EPSILON_S) break;
      }
      j++;
    }
    const run = intervals.slice(i, j);
    spans.push(run.length >= 2 ? toBurstSpan(run) : toFocusSpan(run[0]));
    i = j;
  }
  return spans;
}

function toFocusSpan(iv: AmbientInterval): AmbientTimelineSpan {
  return {
    from: toLocalIso(new Date(iv.startMs)),
    to: toLocalIso(new Date(iv.endMs)),
    kind: "focus",
    app: iv.app,
    titles: iv.titles.length > 0 ? iv.titles.slice(0, MAX_TITLES_PER_SPAN) : undefined,
    minutes: round1((iv.endMs - iv.startMs) / 60000),
    active_minutes: round1(iv.activeMs / 60000),
    idle_minutes: round1(iv.idleMs / 60000),
  };
}

function toBurstSpan(run: AmbientInterval[]): AmbientTimelineSpan {
  const apps: string[] = [];
  const titles: string[] = [];
  for (const iv of run) {
    if (!apps.includes(iv.app)) apps.push(iv.app);
    for (const title of iv.titles) if (!titles.includes(title)) titles.push(title);
  }
  const startMs = run[0].startMs;
  const endMs = run[run.length - 1].endMs;
  const activeMs = run.reduce((sum, iv) => sum + iv.activeMs, 0);
  const idleMs = run.reduce((sum, iv) => sum + iv.idleMs, 0);
  return {
    from: toLocalIso(new Date(startMs)),
    to: toLocalIso(new Date(endMs)),
    kind: "burst",
    app: "multiple",
    titles: titles.length > 0 ? titles.slice(0, MAX_TITLES_PER_SPAN) : undefined,
    apps,
    minutes: round1((endMs - startMs) / 60000),
    active_minutes: round1(activeMs / 60000),
    idle_minutes: round1(idleMs / 60000),
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
