/**
 * Reading the collector's log. Pure: no I/O, no model calls. `parseAmbientLogV2` turns the
 * JSONL into typed lines; `intervals.ts` measures a day from them; `chunks.ts` cuts and
 * labels it. The chrome suppression at the bottom is the one piece of content shaping that
 * lives here, because it is computed across a whole day rather than per stretch.
 */

/** One screen-content extraction, stamped with when it was taken. */
export type AmbientContentSnapshot = { t: string; text: string };

/**
 * One focus block from `collector/collect.ps1` — a completed stretch of continuous focus on
 * one window.
 */
export type AmbientSample = {
  /** Block start, UTC. */
  t: string;
  app: string;
  title: string;
  dwell_s: number;
  /**
   * Seconds of `dwell_s` with detected keyboard/mouse input, from Windows'
   * `GetLastInputInfo` — presence and timing of input only, never what was pressed or
   * clicked. Optional so logs written before this field existed still parse. Under the idle
   * rule this is only a fallback: idle comes from the recorded runs when a log has them.
   */
  active_s?: number;
  /**
   * Screen-content extractions taken during this block, from Windows' UI Automation API.
   * Real screen content, not a title — it is what lets a stretch be named for what it was
   * about instead of which app held focus. Zero or more timestamped snapshots,
   * chronological. Absent when extraction failed or produced nothing meaningfully longer
   * than the title. A legacy line (one `content` string, no series) parses as a one-element
   * series.
   */
  contents?: AmbientContentSnapshot[];
};

/** One run of no input, as the collector recorded it: `t` is the last input event (UTC), `s` how long until the next. */
export type AmbientIdleRun = { t: string; s: number };

/** A stretch nobody was at the machine at all: the session was locked, or the machine slept. */
export type AmbientAwayRun = { t: string; s: number; why: "lock" | "sleep" };

/**
 * A whole log file, every line kind kept apart. `format` is 2 when the collector wrote a
 * v2 `start` line, meaning idle runs were recorded; 1 means only the per-block input
 * seconds exist and idle has to be estimated (see `idle.ts`).
 */
export type AmbientLog = {
  samples: AmbientSample[];
  idle: AmbientIdleRun[];
  away: AmbientAwayRun[];
  format: 1 | 2;
  /** The recording floor the collector used, in seconds, when known. */
  idleFloorS: number | null;
  /** UTC instants of every collector start in this file. Samples before the first predate idle recording. */
  startedAt: string[];
};

/** An app needs at least this many snapshots that day before "recurs in most of them" means anything. */
const MIN_SNAPSHOTS_FOR_CHROME = 4;
/** A line recurring in at least this share of an app's snapshots is chrome. */
const CHROME_DOC_FREQUENCY = 0.6;
/**
 * A chrome line must also be short. A long line that persists across snapshots is usually
 * real content that stayed on screen (a prompt visible in every snapshot of one
 * conversation) — without this guard the filter would delete exactly the conversation it's
 * meant to protect.
 */
const MAX_CHROME_LINE_CHARS = 160;

/** Per app, the lines that count as chrome. */
export type ChromeVocabulary = Map<string, Set<string>>;

/**
 * Removes repeating interface chrome from screen-content snapshots, per app: a short line
 * recurring across most of that app's snapshots that day (a menu label, a status readout)
 * carries no topic information and crowds out the text budget for the lines that do.
 * Computed once per app across everything it produced that day up to the end of the
 * stretch being cleaned, not per block — a line only earns "chrome" status by recurring
 * *across* separate moments, which a single block can never establish on its own.
 */
export function applyChromeSuppression(samples: AmbientSample[]): { samples: AmbientSample[]; chromeLinesSuppressed: number } {
  const chrome = chromeVocabulary(samples);
  let chromeLinesSuppressed = 0;
  for (const lines of chrome.values()) chromeLinesSuppressed += lines.size;
  if (chrome.size === 0) return { samples, chromeLinesSuppressed: 0 };
  return { samples: suppressChrome(samples, chrome), chromeLinesSuppressed };
}

/** The chrome lines per app, learned from these samples' snapshots. */
export function chromeVocabulary(samples: AmbientSample[]): ChromeVocabulary {
  const snapshotCountByApp = new Map<string, number>();
  const lineFreqByApp = new Map<string, Map<string, number>>();
  for (const s of samples) {
    if (!s.contents?.length) continue;
    snapshotCountByApp.set(s.app, (snapshotCountByApp.get(s.app) ?? 0) + s.contents.length);
    const lineFreq = lineFreqByApp.get(s.app) ?? new Map<string, number>();
    for (const snap of s.contents) {
      for (const line of uniqueLines(snap.text)) {
        lineFreq.set(line, (lineFreq.get(line) ?? 0) + 1);
      }
    }
    lineFreqByApp.set(s.app, lineFreq);
  }

  const chromeByApp: ChromeVocabulary = new Map();
  for (const [app, lineFreq] of lineFreqByApp) {
    const n = snapshotCountByApp.get(app) ?? 0;
    if (n < MIN_SNAPSHOTS_FOR_CHROME) continue;
    const chrome = new Set<string>();
    for (const [line, freq] of lineFreq) {
      if (line.length <= MAX_CHROME_LINE_CHARS && freq / n >= CHROME_DOC_FREQUENCY) chrome.add(line);
    }
    if (chrome.size > 0) chromeByApp.set(app, chrome);
  }
  return chromeByApp;
}

/** Strips a vocabulary's chrome lines from every snapshot; a snapshot left empty is dropped. */
export function suppressChrome(samples: AmbientSample[], chromeByApp: ChromeVocabulary): AmbientSample[] {
  return samples.map((s) => {
    const chrome = chromeByApp.get(s.app);
    if (!chrome || !s.contents?.length) return s;
    const contents = s.contents
      .map((snap) => ({ t: snap.t, text: uniqueLines(snap.text).filter((line) => !chrome.has(line)).join("\n") }))
      .filter((snap) => snap.text.length > 0);
    return { ...s, contents: contents.length > 0 ? contents : undefined };
  });
}

/** Splits on newlines, trims, drops blanks, and dedups within one snapshot's text, preserving first-seen order. */
function uniqueLines(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/**
 * The collector stores raw instants in UTC (`Z`-suffixed) — correct for storage, but
 * reading a raw UTC timestamp as if it were a clock time is exactly the bug that made an
 * 11:xx block actually mean 13:xx local. Every timestamp exposed to the model or to a
 * human goes through this instead: same instant, formatted in this machine's own local
 * timezone with its offset. This app runs on the same machine it reads from — there is no
 * cross-timezone case to handle.
 */
export function toLocalIso(instant: Date): string {
  const offsetMinutes = -instant.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = pad2(Math.floor(Math.abs(offsetMinutes) / 60));
  const offsetRemainder = pad2(Math.abs(offsetMinutes) % 60);
  return (
    `${instant.getFullYear()}-${pad2(instant.getMonth() + 1)}-${pad2(instant.getDate())}` +
    `T${pad2(instant.getHours())}:${pad2(instant.getMinutes())}:${pad2(instant.getSeconds())}` +
    `${sign}${offsetHours}:${offsetRemainder}`
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** The collector's on-disk JSON shape — every era. */
type RawAmbientLine = {
  /** Absent on focus blocks; `start`, `idle` or `away` on the event lines of a v2 log. */
  kind?: unknown;
  v?: unknown;
  s?: unknown;
  why?: unknown;
  idle_floor_s?: unknown;
  t?: unknown;
  app?: unknown;
  title?: unknown;
  dwell_s?: unknown;
  active_s?: unknown;
  /** Legacy single-snapshot field, written by the collector before the multi-snapshot change. */
  content?: unknown;
  /** Current multi-snapshot field. */
  contents?: unknown;
};

/**
 * Normalizes a parsed line's content into the series shape, accepting either era of the
 * collector's output: a `contents` array (current), or a lone `content` string paired with
 * the sample's own `t` (legacy — becomes a one-element series). Anything malformed inside
 * `contents` is dropped entry-by-entry rather than discarding the whole sample.
 */
function normalizeContents(parsed: RawAmbientLine): AmbientContentSnapshot[] | undefined {
  if (Array.isArray(parsed.contents)) {
    const items: AmbientContentSnapshot[] = [];
    for (const entry of parsed.contents) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { t?: unknown }).t === "string" &&
        typeof (entry as { text?: unknown }).text === "string"
      ) {
        items.push({ t: (entry as { t: string }).t, text: (entry as { text: string }).text });
      }
    }
    return items.length > 0 ? items : undefined;
  }
  if (typeof parsed.content === "string" && parsed.content.length > 0 && typeof parsed.t === "string") {
    return [{ t: parsed.t, text: parsed.content }];
  }
  return undefined;
}

/** Focus blocks only. See `parseAmbientLogV2` for the full parse. */
export function parseAmbientLog(raw: string): AmbientSample[] {
  return parseAmbientLogV2(raw).samples;
}

/**
 * One focus block from its parsed JSON, or `null` when it is not one. The same shape the
 * log holds is what the collector writes for the block it still has open (`live.json`), so
 * both are read here.
 */
export function toSample(value: unknown): AmbientSample | null {
  if (!value || typeof value !== "object") return null;
  const parsed = value as RawAmbientLine;
  if (typeof parsed.t !== "string" || typeof parsed.app !== "string" || typeof parsed.title !== "string" || typeof parsed.dwell_s !== "number") {
    return null;
  }
  return {
    t: parsed.t,
    app: parsed.app,
    title: parsed.title,
    dwell_s: parsed.dwell_s,
    active_s: typeof parsed.active_s === "number" ? parsed.active_s : undefined,
    contents: normalizeContents(parsed),
  };
}

/**
 * Parses the collector's JSONL, tolerating a trailing partial line — the file may be read
 * while `collect.ps1` is mid-write. Malformed lines are skipped rather than throwing, since
 * one corrupt line should never take down the whole day.
 */
export function parseAmbientLogV2(raw: string): AmbientLog {
  const log: AmbientLog = { samples: [], idle: [], away: [], format: 1, idleFloorS: null, startedAt: [] };
  for (const line of raw.split("\n")) {
    const trimmed = line.replace(/^﻿/, "").trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as RawAmbientLine;
      if (typeof parsed.t !== "string") continue;

      if (parsed.kind === "start") {
        if (typeof parsed.v === "number" && parsed.v >= 2) log.format = 2;
        if (typeof parsed.idle_floor_s === "number") log.idleFloorS = parsed.idle_floor_s;
        log.startedAt.push(parsed.t);
        continue;
      }
      if (parsed.kind === "idle") {
        if (typeof parsed.s === "number" && parsed.s > 0) log.idle.push({ t: parsed.t, s: parsed.s });
        continue;
      }
      if (parsed.kind === "away") {
        if (typeof parsed.s === "number" && parsed.s > 0 && (parsed.why === "lock" || parsed.why === "sleep")) {
          log.away.push({ t: parsed.t, s: parsed.s, why: parsed.why });
        }
        continue;
      }
      if (parsed.kind !== undefined) continue;

      const sample = toSample(parsed);
      if (sample) log.samples.push(sample);
    } catch {
      // Last line mid-write, or a hand-edited file — skip it, don't fail the whole read.
      continue;
    }
  }
  return log;
}
