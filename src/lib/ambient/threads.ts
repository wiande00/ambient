import type { AmbientChunk } from "./chunks";
import { idleWithin, round1, type AmbientDayMeasure } from "./intervals";
import type { ThreadKind } from "./lenses";

/**
 * Threads under chunks: what each stretch was spent on — the conversations, pages and
 * documents it held — measured to the minute and divided by project.
 *
 * A chunk's sentence is coarse on purpose and its ledger divides it between projects; this
 * is the level beneath both, read straight off the collector's log (`lenses.ts`) with no
 * model involved. It costs nothing, works on every past day, and needs no API key. It is
 * attached on the way out of a route rather than stored, so it always reflects the lenses
 * as they are now and the chunk cache never changes shape for it.
 */

/** One thread's share of a chunk, inside one of the chunk's project lines. */
export type AmbientThreadLine = {
  name: string;
  kind: ThreadKind;
  app: string;
  /** The ledger line's project: the thread's time counts where the ledger put it. */
  project: string;
  minutes: number;
  activeMinutes: number;
  /** True on the line that sums every thread past the ones listed, so the lines still add up to the chunk. */
  rest?: boolean;
};

/** Threads listed per chunk before the rest are summed into one line. */
export const MAX_THREADS_PER_CHUNK = 6;

/** A stretch of one thread inside a range, measured. */
type Slice = { key: string; name: string; kind: ThreadKind; app: string; totalMs: number; idleMs: number };

/**
 * Every thread's time inside `[fromMs, toMs)`, from the day's intervals. A session (working
 * off the computer) has no threads, and a stretch the person removed is not in the edited
 * day at all, so neither shows up here.
 */
export function threadSlices(day: AmbientDayMeasure, fromMs: number, toMs: number): Slice[] {
  const byKey = new Map<string, Slice>();
  for (const iv of day.intervals) {
    if (iv.manual || iv.endMs <= fromMs || iv.startMs >= toMs) continue;
    for (const run of iv.threads ?? []) {
      const startMs = Math.max(run.startMs, fromMs);
      const endMs = Math.min(run.endMs, toMs);
      if (endMs <= startMs) continue;
      const slice = byKey.get(run.key) ?? { key: run.key, name: run.name, kind: run.kind, app: iv.app, totalMs: 0, idleMs: 0 };
      slice.totalMs += endMs - startMs;
      slice.idleMs += idleWithin(iv, startMs, endMs, day.idle);
      byKey.set(run.key, slice);
    }
  }
  return [...byKey.values()];
}

/**
 * Each chunk with `threads`: its time divided by thread within each of its ledger lines,
 * longest first, the tail summed into one `rest` line. `day` must be the measure the chunks
 * were drawn from after edits (`LoadedDay.edited`), so a removed stretch adds nothing.
 */
export function attachThreads(chunks: AmbientChunk[], day: AmbientDayMeasure): (AmbientChunk & { threads: AmbientThreadLine[] })[] {
  return chunks.map((chunk) => {
    const lines = chunk.projects?.length ? chunk.projects : [{ project: chunk.project, from: chunk.from, to: chunk.to }];
    const all: AmbientThreadLine[] = [];
    for (const line of lines) {
      for (const slice of threadSlices(day, Date.parse(line.from), Date.parse(line.to))) {
        all.push({
          name: slice.name,
          kind: slice.kind,
          app: slice.app,
          project: line.project,
          minutes: slice.totalMs / 60000,
          activeMinutes: (slice.totalMs - slice.idleMs) / 60000,
        });
      }
    }
    // The same thread under the same project in two ledger lines is one line.
    const merged = new Map<string, AmbientThreadLine>();
    for (const line of all) {
      const key = `${line.project}\u0000${line.app}\u0000${line.name}`;
      const hit = merged.get(key);
      if (hit) {
        hit.minutes += line.minutes;
        hit.activeMinutes += line.activeMinutes;
      } else merged.set(key, { ...line });
    }
    const sorted = [...merged.values()].sort((a, b) => b.minutes - a.minutes);
    const shown = sorted.slice(0, MAX_THREADS_PER_CHUNK);
    const tail = sorted.slice(MAX_THREADS_PER_CHUNK);
    const threads = shown.map((line) => ({ ...line, minutes: round1(line.minutes), activeMinutes: round1(line.activeMinutes) }));
    if (tail.length > 0) {
      threads.push({
        name: "",
        kind: "app",
        app: "",
        project: chunk.project,
        minutes: round1(tail.reduce((sum, line) => sum + line.minutes, 0)),
        activeMinutes: round1(tail.reduce((sum, line) => sum + line.activeMinutes, 0)),
        rest: true,
      });
    }
    return { ...chunk, threads };
  });
}

/** One thread's total across many chunks or days. */
export type AmbientThreadTotal = {
  name: string;
  kind: ThreadKind;
  app: string;
  /** The project that held most of this thread's time, or null when none of it was labelled. */
  project: string | null;
  minutes: number;
  activeMinutes: number;
};

/**
 * Threads summed across chunks, longest first, each under the project that held most of
 * its time. `rest` lines are left out: they are many threads, not one.
 */
export function threadTotals(chunks: { threads?: AmbientThreadLine[] }[], limit = 12): AmbientThreadTotal[] {
  const totals = new Map<string, AmbientThreadTotal & { byProject: Map<string, number> }>();
  for (const chunk of chunks) {
    for (const line of chunk.threads ?? []) {
      if (line.rest) continue;
      const key = `${line.app}\u0000${line.name}`;
      const total = totals.get(key) ?? { name: line.name, kind: line.kind, app: line.app, project: null, minutes: 0, activeMinutes: 0, byProject: new Map() };
      total.minutes += line.minutes;
      total.activeMinutes += line.activeMinutes;
      // An empty project is time nobody has labelled: it counts, but it does not vote.
      if (line.project) total.byProject.set(line.project, (total.byProject.get(line.project) ?? 0) + line.minutes);
      totals.set(key, total);
    }
  }
  return [...totals.values()]
    .map(({ byProject, ...total }) => {
      let project: string | null = null;
      let best = 0;
      for (const [key, minutes] of byProject) {
        if (minutes > best) {
          best = minutes;
          project = key;
        }
      }
      return { ...total, project, minutes: round1(total.minutes), activeMinutes: round1(total.activeMinutes) };
    })
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, limit);
}

/** The day's threads with no project attached, for a day nobody has labelled. */
export function dayThreadTotals(day: AmbientDayMeasure, limit = 12): AmbientThreadTotal[] {
  return threadSlices(day, day.firstMs, day.lastMs + 1)
    .map((slice) => ({
      name: slice.name,
      kind: slice.kind,
      app: slice.app,
      project: null,
      minutes: round1(slice.totalMs / 60000),
      activeMinutes: round1((slice.totalMs - slice.idleMs) / 60000),
    }))
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, limit);
}
