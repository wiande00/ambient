import { stat } from "node:fs/promises";
import { daySegments, type AmbientChunk } from "@/lib/ambient/chunks";
import { editsForDay, EMPTY_EDITS, measureWithEdits, overlayEdits, type EditRange } from "@/lib/ambient/edits";
import { measureDay, type AmbientDayMeasure } from "@/lib/ambient/intervals";
import { withLive } from "@/lib/ambient/live";
import { rangesForDay } from "@/lib/ambient/offComputer";
import { parseAmbientLogV2, type AmbientLog } from "@/lib/ambient/rollup";
import { editsMtime, readEdits } from "./edits";
import { offComputerMtime, readOffComputer } from "./offComputer";
import { logPathFor, readLive, readLog, todayStamp } from "./store";

/**
 * Loading and caching whole days of collector output.
 *
 * A week view reads seven logs, each up to a few megabytes, on every request. So days are
 * memoised here, keyed on the log file's modification time — a changed log invalidates its
 * own entry with no version constant to remember to bump, the same trick `hashReadInput`
 * uses on the read cache.
 *
 * This is deliberate process-local mutable state in the I/O layer, which is a different
 * thing from the scratch state a pure function must never keep: `measureDay` stays pure and
 * is simply handed the result. The cache is per server process and is allowed to be cold;
 * nothing below depends on it having been warm.
 */

export type LoadedDay = {
  date: string;
  log: AmbientLog;
  /** The day as the collector saw it, with the off-computer sessions: what the model labels. */
  measure: AmbientDayMeasure;
  /** The same day with the person's edits applied: what every figure is drawn from. `measure` itself when there are none. */
  edited: AmbientDayMeasure;
  /** The edits touching this day, clipped to it, ascending. */
  edits: EditRange[];
};

const cache = new Map<string, { key: string; day: LoadedDay }>();
/**
 * Parsed logs, keyed on the log's mtime alone. Today is re-measured whenever the
 * collector's live snapshot moves, every few seconds, and re-parsing megabytes of log for
 * each of those would be most of the cost.
 */
const parsed = new Map<string, { mtimeMs: number; log: AmbientLog }>();

const EMPTY_LOG: AmbientLog = { samples: [], idle: [], away: [], format: 2, idleFloorS: null, startedAt: [] };

/**
 * Today's log grows while the collector runs, so its mtime moves and it re-parses; a closed
 * day parses once per process. The idle threshold and the off-computer and edits files'
 * mtimes are part of the key, so a change on the Settings screen, a flick of the switch or
 * an edit to a chunk re-measures on the next load.
 *
 * Today also takes in the collector's live snapshot: the block it has open and the idle run
 * in progress, neither of which is in the log yet (`lib/ambient/live.ts`). A day measured
 * with either of those, or with an off-computer session still running, is never cached,
 * since each ends "now". Returns `null` when the date has neither a log, a session nor an
 * open block.
 */
export async function loadDay(date: string, thresholdS: number): Promise<LoadedDay | null> {
  const [logMtime, offMtime, editMtime] = await Promise.all([
    stat(logPathFor(date)).then(
      (s) => s.mtimeMs,
      () => null,
    ),
    offComputerMtime(),
    editsMtime(),
  ]);
  const isToday = date === todayStamp();
  const key = `${logMtime ?? "none"}:${offMtime}:${editMtime}:${thresholdS}`;
  const hit = cache.get(date);
  if (hit && hit.key === key && !isToday) return hit.day;

  const nowMs = Date.now();
  const [manual, logged, live, editsFile] = await Promise.all([
    offMtime === 0 ? [] : readOffComputer().then((file) => rangesForDay(file, date, nowMs)),
    logMtime === null ? null : parsedLog(date, logMtime),
    isToday ? readLive() : null,
    editMtime === 0 ? EMPTY_EDITS : readEdits(),
  ]);
  const log = withLive(logged ?? EMPTY_LOG, live, nowMs);
  if (log === EMPTY_LOG && manual.length === 0) {
    cache.delete(date);
    return null;
  }
  // Nothing moved since last time, and last time had no "now" in it: the cached measure stands.
  if (hit && hit.key === key && log === logged) return hit.day;

  const measure = measureDay(date, log, thresholdS, manual);
  const edits = editsForDay(editsFile, date);
  const edited = edits.length === 0 ? measure : measureWithEdits(date, log, thresholdS, manual, edits, measure);
  const day: LoadedDay = { date, log, measure, edited, edits };
  const open = log !== logged || manual.some((range) => range.endMs === nowMs);
  if (open) cache.delete(date);
  else cache.set(date, { key, day });
  return day;
}

/**
 * The day's chunks with the person's edits laid over them. `raw` are the chunks as labelled
 * from the unedited day — what the chunk cache holds — so an edit never touches a label and
 * the cache never has to be rewritten for one.
 */
export function withEdits(raw: AmbientChunk[], day: LoadedDay, breakMinutes: number): AmbientChunk[] {
  if (day.edits.length === 0) return raw;
  return overlayEdits(raw, day.edits, day.edited, daySegments(day.edited, breakMinutes));
}

async function parsedLog(date: string, mtimeMs: number): Promise<AmbientLog | null> {
  const hit = parsed.get(date);
  if (hit && hit.mtimeMs === mtimeMs) return hit.log;
  const raw = await readLog(date);
  if (raw === null) {
    parsed.delete(date);
    return null;
  }
  const log = parseAmbientLogV2(raw);
  parsed.set(date, { mtimeMs, log });
  return log;
}

/**
 * Date-stamp arithmetic through `Date`'s month rollover rather than by adding milliseconds,
 * which would land on the wrong day across a DST boundary — the same trap `todayStamp`
 * avoids by building from local parts instead of `.toISOString()`.
 */
export function shiftDays(dateStamp: string, delta: number): string {
  const [y, m, d] = dateStamp.split("-").map(Number);
  const at = new Date(y, m - 1, d + delta);
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
