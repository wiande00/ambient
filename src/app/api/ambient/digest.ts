import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { editsForDay } from "@/lib/ambient/edits";
import { rangesForDay } from "@/lib/ambient/offComputer";
import { toLocalIso } from "@/lib/ambient/rollup";
import { attachThreads, dayThreadTotals, type AmbientThreadLine } from "@/lib/ambient/threads";
import { chunkCacheMtime, readChunkCache } from "./chunkCache";
import { loadDay, withEdits } from "./days";
import { readEdits } from "./edits";
import { readOffComputer } from "./offComputer";
import { ambientDir, logPathFor, todayStamp } from "./store";

/**
 * A day boiled down to what a search reads: each stretch's sentence, project and threads,
 * and nothing else. Searching weeks of days through `loadDay` would parse and hold every
 * log — several megabytes each — so a finished day is written down once, small, under
 * `~/.ambient/digest/<date>.json`, and read from there afterwards.
 *
 * Derived data, like the chunk cache: keyed on everything it was built from (the log, the
 * day's edits and sessions, the chunk cache, the thresholds and this file's version), so
 * anything that changes the day rebuilds its digest on the next read, and deleting the
 * folder loses nothing. Today is never written; it is still moving.
 */

/** Bumped when the digest's shape or the lenses that feed it change, so old digests rebuild. */
const DIGEST_VERSION = 1;

export type DigestStretch = {
  from: string;
  to: string;
  /** Empty on a day nobody has labelled. */
  project: string;
  label: string | null;
  what: string;
  minutes: number;
  activeMinutes: number;
  threads: AmbientThreadLine[];
};

export type DayDigest = { version: number; key: string; date: string; stretches: DigestStretch[] };

function digestPath(date: string): string {
  return join(ambientDir(), "digest", `${date}.json`);
}

function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/** Everything the digest depends on, as one string. Per-day hashes of the edits and sessions, so one edit does not rebuild every day. */
async function sourceKey(date: string, afkSeconds: number, breakMinutes: number): Promise<string | null> {
  const logMtime = await stat(logPathFor(date)).then(
    (s) => s.mtimeMs,
    () => null,
  );
  if (logMtime === null) return null;
  const [edits, sessions, cacheMtime] = await Promise.all([readEdits(), readOffComputer(), chunkCacheMtime(date)]);
  const dayEdits = editsForDay(edits, date).map((range) => range.edit);
  const daySessions = rangesForDay(sessions, date, Date.now());
  return [DIGEST_VERSION, logMtime, hashOf(dayEdits), hashOf(daySessions), cacheMtime, afkSeconds, breakMinutes].join(":");
}

/** The day's stretches with their threads, as the day and chunks routes would show them. */
async function buildStretches(date: string, afkSeconds: number, breakMinutes: number): Promise<DigestStretch[] | null> {
  const [day, cache] = await Promise.all([loadDay(date, afkSeconds), readChunkCache(date)]);
  if (!day || day.measure.intervals.length === 0) return null;
  if (cache) {
    return attachThreads(withEdits(cache.chunks, day, breakMinutes), day.edited).map((chunk) => ({
      from: chunk.from,
      to: chunk.to,
      project: chunk.label === null ? "" : chunk.project,
      label: chunk.label,
      what: chunk.what,
      minutes: chunk.minutes,
      activeMinutes: chunk.activeMinutes,
      threads: chunk.label === null ? chunk.threads.map((line) => ({ ...line, project: "" })) : chunk.threads,
    }));
  }
  // Never labelled: the day as one stretch of threads with no project, so its time is still findable.
  const threads = dayThreadTotals(day.edited, Number.POSITIVE_INFINITY).map((total) => ({ ...total, project: "" }));
  return [
    {
      from: toLocalIso(new Date(day.edited.firstMs)),
      to: toLocalIso(new Date(day.edited.lastMs)),
      project: "",
      label: null,
      what: "",
      minutes: day.edited.totals.trackedMinutes,
      activeMinutes: day.edited.totals.activeMinutes,
      threads,
    },
  ];
}

/**
 * The day's digest: read from disk when its key still matches, built (and, for a finished
 * day, written) otherwise. Null for a date with no log.
 */
export async function readDigest(date: string, afkSeconds: number, breakMinutes: number): Promise<DayDigest | null> {
  const key = await sourceKey(date, afkSeconds, breakMinutes);
  if (key === null) return null;
  const isToday = date === todayStamp();
  if (!isToday) {
    try {
      const stored = JSON.parse(await readFile(digestPath(date), "utf8")) as Partial<DayDigest>;
      if (stored.version === DIGEST_VERSION && stored.key === key && Array.isArray(stored.stretches)) return stored as DayDigest;
    } catch {
      // Missing or unreadable: build it.
    }
  }
  const stretches = await buildStretches(date, afkSeconds, breakMinutes);
  if (stretches === null) return null;
  const digest: DayDigest = { version: DIGEST_VERSION, key, date, stretches };
  if (!isToday) {
    try {
      await mkdir(join(ambientDir(), "digest"), { recursive: true });
      const target = digestPath(date);
      await writeFile(`${target}.tmp`, JSON.stringify(digest), "utf8");
      await rename(`${target}.tmp`, target);
    } catch {
      // Derived data: the answer stands even if it never lands on disk.
    }
  }
  return digest;
}
