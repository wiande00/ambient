import type { AmbientChunk } from "./chunks";
import { idleWithin, round1, type AmbientDayMeasure } from "./intervals";
import type { ThreadKind } from "./lenses";
import { subtractRanges } from "./offComputer";
import { toLocalIso } from "./rollup";

/**
 * Focus and rhythm: how the day's attention moved, measured. When work started and stopped,
 * which hours held it, how often it changed thread, how much of it came in glances, and the
 * longest stretch it stayed on one thing. Arithmetic over the thread runs (`lenses.ts`) and
 * the idle rule — no model, no key, every past day. Stated as figures, never as a grade:
 * forty switches an hour is what a day of messages looks like, not a failing.
 */

export type AmbientFocus = {
  /** The first and last moment of active time, local ISO; null on a day with none. */
  firstActiveAt: string | null;
  lastActiveAt: string | null;
  /** Active minutes in each local clock hour, 0–23. Adds up to the day's active minutes. */
  activeByHour: number[];
  /** Changes of thread per active hour, ignoring flickers under `FLICKER_S`; null under a quarter-hour of active time. */
  switchesPerHour: number | null;
  /** Share of active time spent in threads held for less than `GLANCE_S` at a time, 0–1; null when nothing was active. */
  glanceShare: number | null;
  /** Minutes on a call (a meeting app or a meeting page), idle or not: nobody types through a call. */
  meetingMinutes: number;
  /** Minutes on a video page, idle or not. */
  videoMinutes: number;
  /** The longest unbroken stretch on one thread, by active minutes. */
  longestThread: { name: string; app: string; kind: ThreadKind; from: string; to: string; minutes: number; activeMinutes: number } | null;
};

/** A thread shown for less than this is a flicker — alt-tab passing through — not a switch. */
export const FLICKER_S = 10;
/** A thread held for less than this at a time is a glance. */
export const GLANCE_S = 120;
/** A gap between two windows this small is jitter between the collector's writes. */
const JOIN_MS = 5_000;

type Segment = { key: string; name: string; app: string; kind: ThreadKind; startMs: number; endMs: number; idleMs: number };

/** The day's screen time as consecutive thread segments, neighbours on one thread joined. */
function segments(day: AmbientDayMeasure): Segment[] {
  const out: Segment[] = [];
  for (const iv of day.intervals) {
    if (iv.manual) continue;
    for (const run of iv.threads ?? []) {
      const idleMs = idleWithin(iv, run.startMs, run.endMs, day.idle);
      const last = out[out.length - 1];
      if (last && last.key === run.key && run.startMs - last.endMs <= JOIN_MS) {
        last.endMs = run.endMs;
        last.idleMs += idleMs;
      } else {
        out.push({ key: run.key, name: run.name, app: iv.app, kind: run.kind, startMs: run.startMs, endMs: run.endMs, idleMs });
      }
    }
  }
  return out;
}

const activeMs = (segment: Segment) => segment.endMs - segment.startMs - segment.idleMs;

export function dayFocus(day: AmbientDayMeasure): AmbientFocus {
  // First and last active moment, sessions off the computer included: they count as worked.
  let firstMs: number | null = null;
  let lastMs: number | null = null;
  for (const iv of day.intervals) {
    const active = iv.manual
      ? [{ startMs: iv.startMs, endMs: iv.endMs }]
      : iv.estimated
        ? iv.endMs - iv.idleMs > iv.startMs
          ? [{ startMs: iv.startMs, endMs: iv.endMs - iv.idleMs }]
          : []
        : subtractRanges(iv.startMs, iv.endMs, day.idle);
    for (const range of active) {
      if (range.endMs <= range.startMs) continue;
      if (firstMs === null || range.startMs < firstMs) firstMs = range.startMs;
      if (lastMs === null || range.endMs > lastMs) lastMs = range.endMs;
    }
  }

  const [y, m, d] = day.date.split("-").map(Number);
  const activeByHour = Array.from({ length: 24 }, (_, hour) => {
    const fromMs = new Date(y, m - 1, d, hour).getTime();
    const toMs = new Date(y, m - 1, d, hour + 1).getTime();
    let ms = 0;
    for (const iv of day.intervals) {
      const startMs = Math.max(iv.startMs, fromMs);
      const endMs = Math.min(iv.endMs, toMs);
      if (endMs <= startMs) continue;
      ms += endMs - startMs - idleWithin(iv, startMs, endMs, day.idle);
    }
    return round1(ms / 60000);
  });

  const segs = segments(day);
  const screenActiveMs = segs.reduce((sum, segment) => sum + activeMs(segment), 0);

  // A switch is a change between threads each held at least a flicker's length.
  const held = segs.filter((segment) => segment.endMs - segment.startMs >= FLICKER_S * 1000);
  let switches = 0;
  for (let i = 1; i < held.length; i++) if (held[i].key !== held[i - 1].key) switches++;
  const switchesPerHour = screenActiveMs >= 15 * 60000 ? Math.round(switches / (screenActiveMs / 3_600_000)) : null;

  const glanceMs = segs.filter((segment) => segment.endMs - segment.startMs < GLANCE_S * 1000).reduce((sum, segment) => sum + activeMs(segment), 0);
  const glanceShare = screenActiveMs > 0 ? Math.round((glanceMs / screenActiveMs) * 100) / 100 : null;

  let meetingMs = 0;
  let videoMs = 0;
  for (const segment of segs) {
    if (segment.kind === "meeting") meetingMs += segment.endMs - segment.startMs;
    if (segment.kind === "video") videoMs += segment.endMs - segment.startMs;
  }

  // The longest stretch on one thread: flickers through other windows do not break it, a
  // real switch or a gap in observation does.
  let best: { segment: Segment; activeMs: number } | null = null;
  let current: Segment | null = null;
  for (const segment of held) {
    const previous: Segment | null = current;
    const next: Segment =
      previous !== null && previous.key === segment.key && segment.startMs - previous.endMs <= FLICKER_S * 1000 * 3
        ? { ...previous, endMs: segment.endMs, idleMs: previous.idleMs + segment.idleMs }
        : { ...segment };
    current = next;
    const active = activeMs(next);
    if (!best || active > best.activeMs) best = { segment: next, activeMs: active };
  }

  return {
    firstActiveAt: firstMs === null ? null : toLocalIso(new Date(firstMs)),
    lastActiveAt: lastMs === null ? null : toLocalIso(new Date(lastMs)),
    activeByHour,
    switchesPerHour,
    glanceShare,
    meetingMinutes: round1(meetingMs / 60000),
    videoMinutes: round1(videoMs / 60000),
    longestThread:
      best && best.activeMs > 0
        ? {
            name: best.segment.name,
            app: best.segment.app,
            kind: best.segment.kind,
            from: toLocalIso(new Date(best.segment.startMs)),
            to: toLocalIso(new Date(best.segment.endMs)),
            minutes: round1((best.segment.endMs - best.segment.startMs) / 60000),
            activeMinutes: round1(best.activeMs / 60000),
          }
        : null,
  };
}

/** The longest stretch the day stayed on one project, by its chunks' ledgers. */
export type AmbientProjectStretch = { project: string; from: string; to: string; minutes: number; activeMinutes: number };

/** Two ledger lines on one project this close together are one stretch: a short gap, not a change of work. */
const STRETCH_GAP_MS = 2 * 60_000;

/**
 * The longest stretch on one project, from the labelled chunks' ledgers: consecutive lines
 * on the same project joined across gaps of up to two minutes, measured by active minutes.
 * Unlabelled chunks say nothing about a project and are left out. Pure, so the screen and
 * the MCP server can both work it out from the chunks they already have.
 */
export function longestProjectStretch(chunks: AmbientChunk[]): AmbientProjectStretch | null {
  const lines = chunks
    .filter((chunk) => chunk.label !== null)
    .flatMap((chunk) =>
      chunk.projects?.length
        ? chunk.projects
        : [{ project: chunk.project, from: chunk.from, to: chunk.to, minutes: chunk.minutes, activeMinutes: chunk.activeMinutes, idleMinutes: chunk.idleMinutes }],
    )
    .sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
  let best: AmbientProjectStretch | null = null;
  let current: AmbientProjectStretch | null = null;
  for (const line of lines) {
    const previous: AmbientProjectStretch | null = current;
    const next: AmbientProjectStretch =
      previous !== null && previous.project === line.project && Date.parse(line.from) - Date.parse(previous.to) <= STRETCH_GAP_MS
        ? { ...previous, to: line.to, minutes: round1(previous.minutes + line.minutes), activeMinutes: round1(previous.activeMinutes + line.activeMinutes) }
        : { project: line.project, from: line.from, to: line.to, minutes: line.minutes, activeMinutes: line.activeMinutes };
    current = next;
    if (!best || next.activeMinutes > best.activeMinutes) best = next;
  }
  return best;
}
