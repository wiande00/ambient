import { overlapMs, type IdleInterval } from "./idle";
import { round1, type AmbientAwayKind, type AmbientDayMeasure, type AmbientInterval } from "./intervals";
import { offComputerLabel } from "./offComputer";
import { isFallbackBucket, OTHER_BUCKET, type AmbientProject, type FallbackBucket } from "./projects";
import { chromeVocabulary, suppressChrome, toLocalIso, type AmbientContentSnapshot, type AmbientSample } from "./rollup";

/**
 * Chunks: the day as a handful of stretches, each with one sentence and one project.
 *
 * The cutting is arithmetic and the naming is judgement, kept apart on purpose. A day is
 * first cut at its natural breaks — an away gap, a long idle run — into *candidates*, with
 * no model involved, so the boundaries are the same every time and can be tested against a
 * log. The model then reads each candidate and does two things only: writes the sentence,
 * and picks the project. It may split a candidate where the project clearly changed; it may
 * never merge across a break or move a boundary off a real block edge.
 *
 * The granularity this aims for is coarse — three to six chunks a day, one to three hours
 * each — because that is the level at which "where did my hours go" has an answer. "At 16:35
 * I talked to Claude" is a log, not an answer.
 */

/**
 * An away gap at least this long ends a candidate. Shorter absences stay inside one — a
 * coffee, not a break. Fixed rather than settable, and deliberately not raised alongside
 * `DEFAULT_BREAK_MINUTES`: an away gap is time nobody observed, so there is no evidence for
 * what happened in it and no sentence that could honestly cover it. A stretch may never
 * swallow one however long a break the person has asked for.
 */
export const AWAY_SPLIT_MIN = 20;
/**
 * An idle run at least this long is a break in its own right and ends a candidate. The
 * default matches `AWAY_SPLIT_MIN`: twenty minutes away from the machine is a break whether
 * the screen locked or the browser simply sat there untouched, which is the same absence
 * seen two ways. It is a setting — *Break after* on the Settings screen — because where
 * that line falls is a judgement about one person's day, not arithmetic. Passed in
 * everywhere rather than read here, so the cut stays a pure function of the day and the
 * threshold, and a day can be re-cut without restarting anything.
 */
export const DEFAULT_BREAK_MINUTES = 20;
/** Candidates with less tracked time than this are not worth a model call. */
export const MIN_LLM_MIN = 5;
/** Bounds the prompt. The first and last block of a candidate always survive so its boundaries do. */
export const MAX_BLOCKS_PER_CANDIDATE = 40;
/** Below this, a stretch does not earn its own block; runs of short ones fold into a burst. */
const MIN_BLOCK_SECONDS = 30;
/** Titles per block handed to the model. Enough to characterise, not enough to bloat. */
const MAX_TITLES = 3;
/** Characters of screen text per block. The strongest signal, and the most expensive. */
const MAX_TEXT_CHARS = 400;

export type ChunkInputBlock = {
  /** Local ISO, from real interval boundaries. */
  from: string;
  to: string;
  /** The app, or `"multiple"` for a burst of quick switches. */
  app: string;
  minutes: number;
  active_minutes: number;
  idle_minutes: number;
  titles: string[];
  text?: string;
};

export type AmbientCandidate = {
  index: number;
  from: string;
  to: string;
  minutes: number;
  activeMinutes: number;
  idleMinutes: number;
  /** False when the candidate is too small to send to the model, or is a session; it gets a preset chunk. */
  llm: boolean;
  blocks: ChunkInputBlock[];
  /** A "working off the computer" session: its chunk is written here, never by the model. */
  manual?: { project: string; note: string };
};

export type AmbientDaySegment =
  | { kind: "candidate"; index: number; from: string; to: string; minutes: number }
  | { kind: "break"; from: string; to: string; minutes: number }
  | { kind: "away"; from: string; to: string; minutes: number; why: AmbientAwayKind };

/** One line of a chunk's ledger: a stretch of it that belonged to one project, measured. */
export type AmbientProjectSplit = {
  project: string;
  from: string;
  to: string;
  minutes: number;
  activeMinutes: number;
  idleMinutes: number;
};

export type AmbientChunk = {
  from: string;
  to: string;
  /** One sentence, or null when nothing has labelled this stretch yet. */
  label: string | null;
  /** A project key from `projects.json`, or a fallback bucket: the one that held most of the stretch. */
  project: string;
  /**
   * The stretch's minutes divided between projects, tiling it exactly. One line when the
   * stretch was one project, which is most of them. This is what `projectTotals` counts, so
   * a mixed stretch no longer lands whole on its majority project. Absent on chunks assembled
   * before this existed; the totals then fall back to `project` and behave as they used to.
   */
  projects?: AmbientProjectSplit[];
  /** The specific thing inside the project, a few words. Empty when unlabelled. */
  what: string;
  evidence: string[];
  unclear: boolean;
  minutes: number;
  activeMinutes: number;
  idleMinutes: number;
  /** The candidate this chunk came from. */
  candidate: number;
  /** Set when the person said what this stretch was (`edits.ts`); `active` when they counted all of it as worked. */
  edit?: { active: boolean };
};

export type AmbientProjectTotal = {
  project: string;
  minutes: number;
  activeMinutes: number;
  idleMinutes: number;
};

/** What the model reads. Everything in it is measured except the project descriptions, which the person wrote. */
export type ChunkPromptInput = {
  afk_threshold_minutes: number;
  projects: { key: string; name: string; description: string; hints: string[] }[];
  buckets: { key: FallbackBucket; meaning: string }[];
  candidates: {
    index: number;
    from: string;
    to: string;
    minutes: number;
    active_minutes: number;
    idle_minutes: number;
    blocks: ChunkInputBlock[];
  }[];
  /**
   * Stretches of the same day already labelled in an earlier pass, given so a partial call
   * keeps its project choices consistent with them. Never part of a candidate's cache key.
   */
  earlier_today?: { from: string; to: string; project: string; what: string }[];
};

const BUCKET_MEANINGS: Record<FallbackBucket, string> = {
  personal: "Not work: shopping, entertainment, games, social media, personal errands.",
  admin: "Housekeeping that belongs to no project: receipts, accounts, email triage, machine setup.",
  other: "Work on something that is not in the project list, or that the evidence cannot place.",
};

/** A sub-stretch of one interval, after cutting at breaks. */
type Piece = {
  startMs: number;
  endMs: number;
  app: string;
  titles: string[];
  contents: AmbientContentSnapshot[];
  idleMs: number;
  manual?: { project: string; note: string };
};

/**
 * Cuts the day into candidates and the breaks between them. Deterministic: the same day
 * always cuts the same way.
 */
export function buildCandidates(day: AmbientDayMeasure, breakMinutes: number): { candidates: AmbientCandidate[]; segments: AmbientDaySegment[] } {
  const { groups, segments } = cutDay(day, breakMinutes);
  const candidates = groups.map((group, index) => toCandidate(index, cleanPieces(group, day.intervals), day.idle));
  return { candidates, segments };
}

/** The day's cut alone — where the candidates, breaks and gaps fall — without shaping any candidate for the model. */
export function daySegments(day: AmbientDayMeasure, breakMinutes: number): AmbientDaySegment[] {
  return cutDay(day, breakMinutes).segments;
}

function cutDay(day: AmbientDayMeasure, breakMinutes: number): { groups: Piece[][]; segments: AmbientDaySegment[] } {
  const pieces = cutAtBreaks(day.intervals, day.idle, breakMinutes);
  const segments: AmbientDaySegment[] = [];
  const groups: Piece[][] = [];

  let current: Piece[] = [];
  const close = () => {
    if (current.length === 0) return;
    const totalMs = current.reduce((sum, p) => sum + (p.endMs - p.startMs), 0);
    segments.push({
      kind: "candidate",
      index: groups.length,
      from: toLocalIso(new Date(current[0].startMs)),
      to: toLocalIso(new Date(current[current.length - 1].endMs)),
      minutes: round1(totalMs / 60000),
    });
    groups.push(current);
    current = [];
  };
  // A removed stretch at either end of the day is outside every hole between blocks; it
  // is listed all the same, so it can be given back.
  const removedRow = (range: { startMs: number; endMs: number }): AmbientDaySegment => ({
    kind: "away",
    from: toLocalIso(new Date(range.startMs)),
    to: toLocalIso(new Date(range.endMs)),
    minutes: round1((range.endMs - range.startMs) / 60000),
    why: "removed",
  });
  const firstMs = pieces.length > 0 ? pieces[0].startMs : Number.POSITIVE_INFINITY;
  segments.push(...day.removed.filter((range) => range.endMs <= firstMs).map(removedRow));

  let previousEndMs: number | null = null;
  for (const piece of pieces) {
    // A gap before a break is a gap all the same: checked for every piece, so an absence
    // between two idle breaks is drawn rather than skipped.
    if (previousEndMs !== null) {
      const gapMs = piece.startMs - previousEndMs;
      // Whatever its length, a gap the person made by removing a stretch ends a candidate,
      // so it shows in the list where it can be given back.
      const removedMs = overlapMs(previousEndMs, piece.startMs, day.removed);
      if (gapMs / 60000 >= AWAY_SPLIT_MIN || removedMs > 0) {
        close();
        segments.push({
          kind: "away",
          from: toLocalIso(new Date(previousEndMs)),
          to: toLocalIso(new Date(piece.startMs)),
          minutes: round1(gapMs / 60000),
          why: removedMs * 2 >= gapMs ? "removed" : awayWhy(day, previousEndMs, piece.startMs),
        });
      }
    }
    if (piece.kind === "break") {
      close();
      // One idle run spans every window that took focus while nobody was there — on 23
      // September a game and Claude traded focus every few seconds through a 34-minute
      // break — and each of those intervals yields a break piece. Back to back, they are
      // one break, not a row per focus change.
      const last = segments[segments.length - 1];
      if (last?.kind === "break") {
        const startMs = Date.parse(last.from);
        last.to = toLocalIso(new Date(piece.endMs));
        last.minutes = round1((piece.endMs - startMs) / 60000);
        previousEndMs = piece.endMs;
        continue;
      }
      segments.push({ kind: "break", from: toLocalIso(new Date(piece.startMs)), to: toLocalIso(new Date(piece.endMs)), minutes: round1((piece.endMs - piece.startMs) / 60000) });
      previousEndMs = piece.endMs;
      continue;
    }
    // A session is a candidate of its own: it ends whatever screen work preceded it and
    // never mixes with what follows, because its label is already decided.
    if (piece.manual) {
      close();
      current.push(piece);
      close();
    } else {
      current.push(piece);
    }
    previousEndMs = piece.endMs;
  }
  close();

  if (previousEndMs !== null) {
    const lastMs = previousEndMs;
    segments.push(...day.removed.filter((range) => range.startMs >= lastMs).map(removedRow));
  }
  return { groups, segments };
}

/** The explanation the day recorded for a hole, if any. */
function awayWhy(day: AmbientDayMeasure, startMs: number, endMs: number): AmbientAwayKind {
  let why: AmbientAwayKind = "unobserved";
  let best = 0;
  for (const away of day.away) {
    const covered = overlapMs(startMs, endMs, [away]);
    if (covered > best) {
      best = covered;
      why = away.why;
    }
  }
  return why;
}

/**
 * Runs a candidate's screen text through the same chrome suppression the digest used, so a
 * menu label recurring in every snapshot of one app does not eat the text budget. The
 * chrome is learned from the day *up to the candidate's end*: a closed candidate is then
 * cleaned identically however much the day grows after it, which is what lets its label be
 * cached, while the open candidate sees everything the day has produced so far.
 */
function cleanPieces(pieces: Piece[], intervals: AmbientInterval[]): Piece[] {
  const cutoffMs = pieces[pieces.length - 1].endMs;
  const prefix: AmbientSample[] = [];
  for (const iv of intervals) {
    if (iv.startMs >= cutoffMs) break;
    prefix.push(pseudoSample(iv.app, iv.contents));
  }
  const chrome = chromeVocabulary(prefix);
  if (chrome.size === 0) return pieces;
  const cleaned = suppressChrome(
    pieces.map((p) => pseudoSample(p.app, p.contents)),
    chrome,
  );
  return pieces.map((p, i) => ({ ...p, contents: cleaned[i].contents ?? [] }));
}

/** Enough of a sample for chrome suppression, which reads only `app` and `contents`. */
function pseudoSample(app: string, contents: AmbientContentSnapshot[] | undefined): AmbientSample {
  return { t: "", app, title: "", dwell_s: 0, contents: contents?.length ? contents : undefined };
}

/** The process name the collector records for this app's own window. */
const OWN_APP = "ambient";

/**
 * Whether a block is Ambient's own window. Its screen text is this app's output — the day's
 * chunks with their sentences and projects, the editor, the settings — so handing it to the
 * model lets it read its own earlier guesses back as evidence. On 21 September a provisional
 * "09:23–09:35 … Reviewed thesis chapter notes" sat in the dashboard text it was given, and
 * came back as a Thesis split over a quarter-hour block that was mostly a cybersecurity
 * lecture. The block itself stays, title and all, since looking at the day is time spent.
 */
function isOwnWindow(app: string): boolean {
  return app.toLowerCase() === OWN_APP;
}

type CutPiece = (Piece & { kind: "piece" }) | { kind: "break"; startMs: number; endMs: number };

/** Splits every interval at the idle runs inside it that are long enough to be breaks. */
function cutAtBreaks(intervals: AmbientInterval[], idle: IdleInterval[], breakMinutes: number): CutPiece[] {
  const breaks = idle.filter((run) => (run.endMs - run.startMs) / 60000 >= breakMinutes);
  const out: CutPiece[] = [];
  for (const iv of intervals) {
    let cursor = iv.startMs;
    for (const run of breaks) {
      if (run.endMs <= cursor || run.startMs >= iv.endMs) continue;
      const breakStart = Math.max(run.startMs, cursor);
      const breakEnd = Math.min(run.endMs, iv.endMs);
      if (breakStart > cursor) out.push(piece(iv, cursor, breakStart, idle));
      out.push({ kind: "break", startMs: breakStart, endMs: breakEnd });
      cursor = breakEnd;
    }
    if (cursor < iv.endMs) out.push(piece(iv, cursor, iv.endMs, idle));
  }
  return out;
}

function piece(iv: AmbientInterval, startMs: number, endMs: number, idle: IdleInterval[]): CutPiece {
  return {
    kind: "piece",
    startMs,
    endMs,
    app: iv.app,
    titles: iv.titles,
    contents: isOwnWindow(iv.app) ? [] : (iv.contents ?? []).filter((snap) => {
      const at = new Date(snap.t).getTime();
      return at >= startMs && at < endMs;
    }),
    idleMs: iv.estimated ? Math.min(endMs - startMs, estimatedTail(iv, startMs, endMs)) : overlapMs(startMs, endMs, idle),
    ...(iv.manual ? { manual: iv.manual } : {}),
  };
}

/** An estimated interval's idle sits at its tail; a piece gets the part of that tail it covers. */
function estimatedTail(iv: AmbientInterval, startMs: number, endMs: number): number {
  const tailStart = iv.endMs - iv.idleMs;
  return Math.max(0, Math.min(endMs, iv.endMs) - Math.max(startMs, tailStart));
}

function toCandidate(index: number, pieces: Piece[], idle: IdleInterval[]): AmbientCandidate {
  void idle;
  const blocks = shapeBlocks(pieces);
  const totalMs = pieces.reduce((sum, p) => sum + (p.endMs - p.startMs), 0);
  const idleMs = pieces.reduce((sum, p) => sum + p.idleMs, 0);
  const minutes = round1(totalMs / 60000);
  const manual = pieces.length === 1 ? pieces[0].manual : undefined;
  return {
    index,
    from: toLocalIso(new Date(pieces[0].startMs)),
    to: toLocalIso(new Date(pieces[pieces.length - 1].endMs)),
    minutes,
    activeMinutes: round1((totalMs - idleMs) / 60000),
    idleMinutes: round1(idleMs / 60000),
    llm: minutes >= MIN_LLM_MIN && !manual,
    blocks,
    ...(manual ? { manual } : {}),
  };
}

/**
 * Pieces at least `MIN_BLOCK_SECONDS` long stand alone; a run of shorter neighbours folds
 * into one burst block, so quick switching is one thing rather than noise. Then capped by
 * length, keeping the first and last so the candidate's edges stay in the model's view.
 */
function shapeBlocks(pieces: Piece[]): ChunkInputBlock[] {
  const blocks: ChunkInputBlock[] = [];
  let i = 0;
  while (i < pieces.length) {
    const p = pieces[i];
    if ((p.endMs - p.startMs) / 1000 >= MIN_BLOCK_SECONDS) {
      blocks.push(toBlock([p]));
      i++;
      continue;
    }
    let j = i;
    while (j < pieces.length && (pieces[j].endMs - pieces[j].startMs) / 1000 < MIN_BLOCK_SECONDS) j++;
    blocks.push(toBlock(pieces.slice(i, j)));
    i = j;
  }

  if (blocks.length <= MAX_BLOCKS_PER_CANDIDATE) return blocks;
  const middle = blocks.slice(1, -1).sort((a, b) => b.minutes - a.minutes).slice(0, MAX_BLOCKS_PER_CANDIDATE - 2);
  const keep = new Set([blocks[0], blocks[blocks.length - 1], ...middle]);
  return blocks.filter((block) => keep.has(block));
}

function toBlock(run: Piece[]): ChunkInputBlock {
  const startMs = run[0].startMs;
  const endMs = run[run.length - 1].endMs;
  const totalMs = run.reduce((sum, p) => sum + (p.endMs - p.startMs), 0);
  const idleMs = run.reduce((sum, p) => sum + p.idleMs, 0);
  const apps: string[] = [];
  const titles: string[] = [];
  const texts: string[] = [];
  for (const p of run) {
    if (!apps.includes(p.app)) apps.push(p.app);
    for (const title of p.titles) if (!titles.includes(title)) titles.push(title);
    for (const snap of p.contents) texts.push(snap.text);
  }
  const text = texts.join(" ").replace(/\s+/g, " ").trim();
  return {
    from: toLocalIso(new Date(startMs)),
    to: toLocalIso(new Date(endMs)),
    app: run.length === 1 ? run[0].app : "multiple",
    minutes: round1(totalMs / 60000),
    active_minutes: round1((totalMs - idleMs) / 60000),
    idle_minutes: round1(idleMs / 60000),
    titles: titles.filter((title) => title.trim().length > 0).slice(0, MAX_TITLES),
    ...(text.length > 0 ? { text: text.slice(0, MAX_TEXT_CHARS) } : {}),
  };
}

export function toChunkInput(candidates: AmbientCandidate[], projects: AmbientProject[], afkThresholdS: number): ChunkPromptInput {
  return {
    afk_threshold_minutes: Math.round(afkThresholdS / 60),
    projects: projects.map((p) => ({ key: p.key, name: p.name, description: p.description, hints: p.hints })),
    buckets: (Object.keys(BUCKET_MEANINGS) as FallbackBucket[]).map((key) => ({ key, meaning: BUCKET_MEANINGS[key] })),
    candidates: candidates
      .filter((c) => c.llm)
      .map((c) => ({
        index: c.index,
        from: c.from,
        to: c.to,
        minutes: c.minutes,
        active_minutes: c.activeMinutes,
        idle_minutes: c.idleMinutes,
        blocks: c.blocks,
      })),
  };
}

/** A run inside one part that belonged to a project other than the part's own. Times are block edges. */
export type ChunkSplit = { project: string; from: string; to: string };

/** What the model returns, before measuring. */
export type ChunkPart = {
  from: string;
  to: string;
  label: string;
  project: string;
  what: string;
  evidence: string[];
  unclear: boolean;
  /**
   * How the part's time divided between projects, when it divided at all. The sentence stays
   * coarse and the ledger does not have to: this is what keeps twenty minutes of one project
   * inside an hour of another from being credited to the hour.
   */
  split?: ChunkSplit[];
};

/**
 * Every part boundary must be a real block edge inside this candidate, and the parts must
 * be in order without overlapping. A hallucinated time can never widen a stretch across
 * hours nobody worked: anything not matching a block edge rejects the whole candidate,
 * which falls back to one unlabelled chunk.
 *
 * Skipped blocks are tolerated, because the model reliably drops a thirty-second block at
 * the very end of a stretch however firmly it is told not to, and rejecting four hours of
 * labelled work over that is the wrong trade. A skipped block joins the part before it (or
 * the first part, at the start), so the parts always tile the candidate exactly and every
 * boundary is still one the collector measured.
 */
export function validateParts(candidate: AmbientCandidate, parts: ChunkPart[], projectKeys: Set<string>): ChunkPart[] | null {
  if (parts.length === 0) return null;
  const blocks = candidate.blocks;
  const froms = new Map(blocks.map((block, i) => [block.from, i]));
  const tos = new Map(blocks.map((block, i) => [block.to, i]));

  // A boundary may be given as either edge of the block it sits on: a part that "ends" at
  // 16:06:47 where a block *starts* at 16:06:47 means the same instant, and rejecting the
  // day over which edge the model quoted would be pedantry.
  const resolveFirst = (from: string): number | undefined => {
    const at = froms.get(from);
    if (at !== undefined) return at;
    const before = tos.get(from);
    return before === undefined ? undefined : before + 1;
  };
  const resolveLast = (to: string): number | undefined => {
    const at = tos.get(to);
    if (at !== undefined) return at;
    const after = froms.get(to);
    return after === undefined ? undefined : after - 1;
  };

  type Span = { first: number; last: number; part: ChunkPart };
  const resolved: Span[] = [];
  for (const part of parts) {
    const first = resolveFirst(part.from);
    const last = resolveLast(part.to);
    if (first === undefined || last === undefined || last < first || first >= blocks.length) return null;
    resolved.push({ first, last, part });
  }
  resolved.sort((a, b) => a.first - b.first);

  // Overlaps drop the later part rather than the day.
  const spans: Span[] = [];
  for (const span of resolved) {
    const previous = spans[spans.length - 1];
    if (previous && span.first <= previous.last) continue;
    spans.push(span);
  }
  if (spans.length === 0) return null;

  const keyOf = (project: string) => (projectKeys.has(project) || isFallbackBucket(project) ? project : OTHER_BUCKET);

  /**
   * A part's split, checked the same way the part itself was: every edge a real block edge
   * inside this part, in order, not overlapping. A split that fails any of that is dropped
   * and the part stands whole, because a bad breakdown is worth less than the sentence.
   */
  const resolveSplit = (span: Span): ChunkSplit[] => {
    const raw = span.part.split;
    if (!raw || raw.length === 0) return [];
    const out: { project: string; first: number; last: number }[] = [];
    for (const entry of raw) {
      const first = resolveFirst(entry.from);
      const last = resolveLast(entry.to);
      if (first === undefined || last === undefined) return [];
      if (last < first || first < span.first || last > span.last) return [];
      out.push({ project: keyOf(entry.project), first, last });
    }
    out.sort((a, b) => a.first - b.first);
    for (let i = 1; i < out.length; i++) if (out[i].first <= out[i - 1].last) return [];
    return out.map(({ project, first, last }) => ({ project, from: blocks[first].from, to: blocks[last].to }));
  };
  for (const span of spans) span.part = { ...span.part, split: resolveSplit(span) };

  /**
   * What a span contributes to a merged ledger: all of it, every run named. A split lists
   * only the runs that were *not* the part's own, leaving the rest to its headline; once
   * two parts merge under one headline, that rest has to be spelled out, or the loser's own
   * minutes would quietly go to the winner's project.
   */
  const effectiveSplit = (span: Span): ChunkSplit[] => {
    const own = keyOf(span.part.project);
    const out: ChunkSplit[] = [];
    let cursor = span.first;
    for (const entry of span.part.split ?? []) {
      const first = froms.get(entry.from) ?? cursor;
      const last = tos.get(entry.to) ?? span.last;
      if (first > cursor) out.push({ project: own, from: blocks[cursor].from, to: blocks[first - 1].to });
      out.push(entry);
      cursor = last + 1;
    }
    if (cursor <= span.last) out.push({ project: own, from: blocks[cursor].from, to: blocks[span.last].to });
    return out;
  };

  /** Neighbours on the same project are one line. */
  const coalesce = (entries: ChunkSplit[]): ChunkSplit[] => {
    const out: ChunkSplit[] = [];
    for (const entry of entries) {
      const last = out[out.length - 1];
      if (last && last.project === entry.project) last.to = entry.to;
      else out.push({ ...entry });
    }
    return out;
  };

  // Too many parts is the model splitting what it was asked not to. Fold neighbours that
  // share a project first, then the smallest neighbouring pair, until three remain. The
  // sentence of whichever member's project held more of the merged ledger survives, and
  // the boundaries stay exact. Folding across two different projects used to hand the
  // shorter one's minutes to the longer one's project; now each side is carried into the
  // merged part's split, so only the sentence is lost.
  const minutesOf = (first: number, last: number) => blocks.slice(first, last + 1).reduce((sum, block) => sum + block.minutes, 0);
  const blockMinutes = (span: Span) => minutesOf(span.first, span.last);
  const heldBy = (ledger: ChunkSplit[], project: string) =>
    ledger.filter((entry) => entry.project === project).reduce((sum, entry) => sum + minutesOf(froms.get(entry.from) ?? 0, tos.get(entry.to) ?? -1), 0);
  while (spans.length > 3) {
    let at = -1;
    for (let i = 0; i + 1 < spans.length; i++) {
      if (spans[i].part.project === spans[i + 1].part.project) {
        at = i;
        break;
      }
    }
    if (at === -1) {
      let smallest = Number.POSITIVE_INFINITY;
      for (let i = 0; i + 1 < spans.length; i++) {
        const size = blockMinutes(spans[i]) + blockMinutes(spans[i + 1]);
        if (size < smallest) {
          smallest = size;
          at = i;
        }
      }
    }
    const a = spans[at];
    const b = spans[at + 1];
    const ledger = coalesce([...effectiveSplit(a), ...effectiveSplit(b)]);
    // Usually the longer member, but not when the longer one had been mostly split away
    // to the shorter one's project: the headline has to be what held most of the merge,
    // or `measureProjects` would rightly refuse the ledger and lose it.
    const heldA = heldBy(ledger, keyOf(a.part.project));
    const heldB = heldBy(ledger, keyOf(b.part.project));
    const longer = heldA > heldB || (heldA === heldB && blockMinutes(a) >= blockMinutes(b)) ? a.part : b.part;
    spans.splice(at, 2, {
      first: a.first,
      last: b.last,
      part: {
        ...longer,
        project: longer.project,
        evidence: [...a.part.evidence, ...b.part.evidence],
        unclear: a.part.unclear && b.part.unclear,
        split: ledger.filter((entry) => entry.project !== keyOf(longer.project)),
      },
    });
  }

  // Snap: the first part opens the candidate, each part runs up to the moment the next one
  // starts, and the last part closes the candidate. Contiguous in time, not just in block
  // index — the model only ever saw the longest forty blocks, and a short one dropped from
  // its view between two parts would otherwise sit between them unlabelled.
  spans[0].first = 0;
  const ends = spans.map((_, i) => (i + 1 < spans.length ? blocks[spans[i + 1].first].from : blocks[blocks.length - 1].to));

  return spans.map((span, i) => ({
    from: blocks[span.first].from,
    to: ends[i],
    label: span.part.label.trim(),
    project: projectKeys.has(span.part.project) || isFallbackBucket(span.part.project) ? span.part.project : OTHER_BUCKET,
    what: span.part.what.trim(),
    evidence: [...new Set(span.part.evidence.map((e) => e.trim()).filter((e) => e.length > 0))].slice(0, 4),
    unclear: span.part.unclear,
    ...(span.part.split && span.part.split.length > 0 ? { split: span.part.split } : {}),
  }));
}

/**
 * The chunk a candidate becomes without the model: a session carries the label the person
 * gave it, and anything else is honestly unlabelled.
 */
export function unlabelledChunk(candidate: AmbientCandidate): AmbientChunk {
  const manual = candidate.manual;
  const project = manual ? manual.project : OTHER_BUCKET;
  return {
    from: candidate.from,
    to: candidate.to,
    label: manual ? offComputerLabel(manual.note) : null,
    project,
    projects: [
      {
        project,
        from: candidate.from,
        to: candidate.to,
        minutes: candidate.minutes,
        activeMinutes: candidate.activeMinutes,
        idleMinutes: candidate.idleMinutes,
      },
    ],
    what: manual ? manual.note : "",
    evidence: [],
    unclear: !manual,
    minutes: candidate.minutes,
    activeMinutes: candidate.activeMinutes,
    idleMinutes: candidate.idleMinutes,
    candidate: candidate.index,
  };
}

/**
 * Attaches the measured figures. Runs after the model, over the day's own intervals, so
 * minutes can never come from a sentence — a stretch is idle because the input says so.
 */
export function measureChunks(candidate: AmbientCandidate, parts: ChunkPart[], day: AmbientDayMeasure): AmbientChunk[] {
  // `split` is the model's answer; `projects` is what the day says those ranges were worth.
  // The chunk keeps only the measured one, so nothing the model stated about time survives.
  return parts.map(({ split, ...part }) => {
    const fromMs = new Date(part.from).getTime();
    const toMs = new Date(part.to).getTime();
    return {
      ...part,
      ...measureSpan(day, fromMs, toMs),
      projects: measureProjects(day, fromMs, toMs, part.project, split),
      candidate: candidate.index,
    };
  });
}

/**
 * A stretch's ledger: the model's split where it gave one, the stretch's own project
 * everywhere else. The ranges tile `[fromMs, toMs)` exactly, so the lines always add back up
 * to the stretch and no minute can be counted twice or dropped between two projects.
 *
 * The split is believed only while the headline still holds the most of the stretch. The
 * headline is what the card's colour, sentence and "what" all claim, and a split is by
 * definition the minority — the runs that were *not* the part's own. A split handing most
 * of the stretch elsewhere contradicts the answer it came with, and believing it is how a
 * nineteen-minute Cybersecurity card came to say "also Thesis 15 min", with project totals
 * no reading of the cards could add up to. Of the two halves, the split is the weaker one:
 * it tags whole blocks, and of a long block the model sees only its opening text. So it is
 * dropped, as a split that fails validation is, and the stretch counts on its headline.
 */
export function measureProjects(
  day: AmbientDayMeasure,
  fromMs: number,
  toMs: number,
  project: string,
  split: ChunkSplit[] | undefined,
): AmbientProjectSplit[] {
  const lines = ledgerLines(day, fromMs, toMs, project, split);
  return headlineHoldsMost(lines, project) ? lines : ledgerLines(day, fromMs, toMs, project, undefined);
}

/** Whether no other project in a ledger held more of it than `project` did. */
function headlineHoldsMost(lines: AmbientProjectSplit[], project: string): boolean {
  const held = new Map<string, number>();
  for (const line of lines) held.set(line.project, (held.get(line.project) ?? 0) + line.minutes);
  const own = held.get(project) ?? 0;
  for (const minutes of held.values()) if (minutes > own) return false;
  return true;
}

function ledgerLines(
  day: AmbientDayMeasure,
  fromMs: number,
  toMs: number,
  project: string,
  split: ChunkSplit[] | undefined,
): AmbientProjectSplit[] {
  const ranges: { project: string; startMs: number; endMs: number }[] = [];
  let cursor = fromMs;
  for (const entry of split ?? []) {
    const startMs = Math.max(fromMs, new Date(entry.from).getTime());
    const endMs = Math.min(toMs, new Date(entry.to).getTime());
    if (!(endMs > startMs) || startMs < cursor) continue;
    if (startMs > cursor) ranges.push({ project, startMs: cursor, endMs: startMs });
    ranges.push({ project: entry.project, startMs, endMs });
    cursor = endMs;
  }
  if (cursor < toMs) ranges.push({ project, startMs: cursor, endMs: toMs });

  const lines: typeof ranges = [];
  for (const range of ranges) {
    const last = lines[lines.length - 1];
    if (last && last.project === range.project) last.endMs = range.endMs;
    else lines.push({ ...range });
  }
  return lines.map((line) => ({
    project: line.project,
    from: toLocalIso(new Date(line.startMs)),
    to: toLocalIso(new Date(line.endMs)),
    ...measureSpan(day, line.startMs, line.endMs),
  }));
}

/** Tracked, active and idle minutes of the day inside `[fromMs, toMs)`. */
export function measureSpan(day: AmbientDayMeasure, fromMs: number, toMs: number): { minutes: number; activeMinutes: number; idleMinutes: number } {
  let totalMs = 0;
  let idleMs = 0;
  for (const iv of day.intervals) {
    const startMs = Math.max(iv.startMs, fromMs);
    const endMs = Math.min(iv.endMs, toMs);
    if (endMs <= startMs) continue;
    totalMs += endMs - startMs;
    idleMs += iv.estimated ? estimatedTail(iv, startMs, endMs) : overlapMs(startMs, endMs, day.idle);
  }
  return {
    minutes: round1(totalMs / 60000),
    activeMinutes: round1((totalMs - idleMs) / 60000),
    idleMinutes: round1(idleMs / 60000),
  };
}

/**
 * Minutes per project across chunks, most active first. Unlabelled chunks count under
 * `other`. Counted from each chunk's ledger rather than its headline project, so a stretch
 * that mixed two projects is divided between them instead of landing whole on the larger.
 * A chunk cached before the ledger existed has none, and takes the old whole-chunk reading.
 */
export function projectTotals(chunks: AmbientChunk[]): AmbientProjectTotal[] {
  const totals = new Map<string, AmbientProjectTotal>();
  for (const chunk of chunks) {
    const lines = chunk.projects?.length
      ? chunk.projects
      : [{ project: chunk.project, minutes: chunk.minutes, activeMinutes: chunk.activeMinutes, idleMinutes: chunk.idleMinutes }];
    for (const line of lines) {
      const total = totals.get(line.project) ?? { project: line.project, minutes: 0, activeMinutes: 0, idleMinutes: 0 };
      total.minutes = round1(total.minutes + line.minutes);
      total.activeMinutes = round1(total.activeMinutes + line.activeMinutes);
      total.idleMinutes = round1(total.idleMinutes + line.idleMinutes);
      totals.set(line.project, total);
    }
  }
  return [...totals.values()].sort((a, b) => b.activeMinutes - a.activeMinutes);
}

export const CHUNK_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      description: "One entry per input candidate, in the same order, each cut into one to three parts.",
      items: {
        type: "object",
        properties: {
          index: { type: "number", description: "The candidate's index, copied from the input." },
          parts: {
            type: "array",
            description: "The candidate as consecutive parts covering all of it. Usually one part.",
            items: {
              type: "object",
              properties: {
                from: { type: "string", description: "The `from` of the first block in this part, copied exactly from the input." },
                to: { type: "string", description: "The `to` of the last block in this part, copied exactly from the input." },
                label: {
                  type: "string",
                  description:
                    "One plain past-tense sentence, up to about twenty words, saying what the person was doing across this part. It may name two or three things when the part held them: \"Mostly the website landing page, with some thesis reading and a look at a job posting\". Name the work, not the software. No praise, no judgement, no advice, no second person.",
                },
                project: {
                  type: "string",
                  description: "Exactly one key from `projects`, or one of the `buckets` keys when the work belonged to no listed project.",
                },
                what: {
                  type: "string",
                  description: "The specific thing inside the project, at most eight words: \"landing page copy\", \"expense receipts\", \"lab 3 buffer overflows\".",
                },
                evidence: {
                  type: "array",
                  description: "Two to four window titles or short quotes from the screen text, copied from the input, that the label rests on.",
                  items: { type: "string" },
                },
                unclear: {
                  type: "boolean",
                  description: "True when the windows do not reveal what the work was, or the part was mostly a window left open. Set it rather than guessing.",
                },
                split: {
                  type: "array",
                  description:
                    "Optional, and usually absent. Runs of blocks inside this part that belonged to a project other than the part's own, so their minutes are counted under the right one. In order, not overlapping, entirely inside this part.",
                  items: {
                    type: "object",
                    properties: {
                      project: { type: "string", description: "A key from `projects`, or one of the `buckets` keys." },
                      from: { type: "string", description: "The `from` of the first block of this run, copied exactly from the input." },
                      to: { type: "string", description: "The `to` of the last block of this run, copied exactly from the input." },
                    },
                    required: ["project", "from", "to"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["from", "to", "label", "project", "what", "evidence", "unclear"],
              additionalProperties: false,
            },
          },
        },
        required: ["index", "parts"],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
} as const;

export const CHUNK_PROMPT = `You are describing one person's day at their computer as a few stretches of work, and
saying which of their projects each stretch belonged to.

The input has three parts. "projects" is the person's own list: a key, a name, a description
they wrote, and hints — words, titles and paths that mark that project's work. "buckets" are
the fixed places for time that belongs to no project. "candidates" is the day, already cut
into continuous stretches at its natural breaks: each one is a list of blocks in order, and
each block is one window that held focus — when it started and ended, the app, the minutes,
how many of those minutes counted as worked ("active_minutes") and how many as idle
("idle_minutes"), the window titles, and often "text": real text read off the screen at that
moment via the OS accessibility API, not a screenshot.

Idle is measured, not guessed: a person counts as idle once "afk_threshold_minutes" pass with
no keyboard or mouse input, from the last input until the next. So a block that ran long
with most of its minutes idle was left open, not worked in. Do not describe such a stretch
as an activity. Say what is true — the window was open and almost untouched — and mark the
part unclear if that is all it contains.

Return the same candidates, in the same order, each as one to three consecutive parts.

"earlier_today", when present, lists stretches of this same day that were already labelled
in an earlier pass — their times, the project chosen and what the work was. They are given
only so the project choices for the candidates below stay consistent with them: the same
work lands in the same project. They are not candidates. Do not return them, do not merge a
candidate into them, and do not let them override what a candidate's own blocks show.

The default is one part per candidate. The cuts between candidates were made at real breaks
in the day, and the goal is a handful of stretches, each an hour or three long, not a log of
every switch. Split a candidate only when the dominant project clearly changed partway
through and each side is at least thirty minutes — a morning that was two hours on one
project and then ninety minutes on another is two parts; a morning that flitted between
them is one part with a compound sentence. Never merge across candidates and never move a
boundary outside one. Copy "from" and "to" exactly from the first and last block of each part.
Every block must fall inside exactly one part.

A part keeps one project — the one that held most of its time — and a sentence that may name
the rest. When the rest was a real amount of time rather than a few minutes' detour, give
"split" as well: one entry per run of consecutive blocks that belonged to a project other
than the part's own, each with that project's key and "from" and "to" copied from block edges
inside the part, in order and not overlapping. So an hour on one project with twenty minutes
of another in the middle of it is one part, one sentence naming both, and one split entry for
the twenty minutes. Leave "split" out when the part was one project throughout, which is the
usual case. Never state a number of minutes anywhere: minutes are measured from the blocks,
and a split only says where the boundaries were.

The label is one plain sentence, past tense, up to about twenty words. It may be compound
when the stretch held several things: "Mostly the website landing page, with some thesis reading
and a look at flights". Lead with what took the most time. Name the work rather than the
tool: "Filed expense receipts", never "Used a browser". Do not score, grade, praise or advise.
Do not address the person. Do not speculate about why the work was done or who asked for it;
the screen shows what was open, not intent.

"project" is exactly one key from the list, chosen from the titles, the screen text, file
paths and the project hints. When the evidence names no listed project — shopping, a game,
a job posting, receipts, machine setup, or something the list does not cover — use a bucket.
Never invent a key. When a stretch mixes projects, pick the one that held most of the time
and let the sentence name the rest.

"what" is the specific thing inside the project, eight words at most. "evidence" is two to
four titles or short quotes copied from the input that the label rests on; if you cannot
point at the evidence, you cannot make the claim.

Screen text is a sample of moments, never a recording. Describe what it showed, not what
happened between samples. A stretch whose windows genuinely say nothing — an app whose
title never changes, no text read from it — gets "unclear": true and a label that states
what is known and no more: "Two hours in a code editor; the window title does not say what
was open". A grounded "cannot tell" is correct. An ungrounded guess is not.`;
