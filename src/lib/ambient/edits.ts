import { measureSpan, type AmbientChunk, type AmbientDaySegment, type AmbientProjectSplit } from "./chunks";
import { measureDay, type AmbientDayMeasure } from "./intervals";
import { subtractRanges, type ManualRange } from "./offComputer";
import { OTHER_BUCKET } from "./projects";
import { toLocalIso, type AmbientLog } from "./rollup";

/**
 * The person's own corrections to a day. The collector can be wrong about what counted as
 * work — twenty minutes writing on paper reads as twenty minutes idle — and the model can
 * be wrong about which project a stretch belonged to. So a stretch can be said to be
 * something else, added where nothing was seen, or taken out of the day altogether.
 *
 * Edits sit on top of what was measured and labelled, never inside it. The model always
 * reads the day as the collector saw it, so correcting one stretch never costs a call and
 * never moves a label anywhere else in the day; the correction is applied when the day is
 * read, to the figures and the chunks alike. Pure: parsing, the range arithmetic, and the
 * overlay. Reading and writing the file is `app/api/ambient/edits.ts`.
 *
 * Every edit is a range on the clock. The file is kept disjoint: a new edit cuts whatever
 * it overlaps out of the older ones before it is added, so the file always says exactly
 * one thing about any moment, and undoing a range is cutting it out of everything.
 */

export type ChunkEdit =
  | {
      id: string;
      /** The stretch was this: a project and a sentence, overriding whatever the model said. */
      kind: "label";
      /** UTC ISO. */
      from: string;
      to: string;
      /** A project key or a fallback bucket. */
      project: string;
      label: string;
      /**
       * Counts the whole stretch as worked, whatever the screen and the keyboard showed —
       * pen and paper, a book, time the collector never saw. False keeps the measured
       * active and idle minutes and changes only what the stretch is called.
       */
      active: boolean;
      /** When the person made it, UTC ISO. */
      at: string;
    }
  | {
      id: string;
      /** The stretch is taken out of the day: not tracked, not away, not in any total. */
      kind: "remove";
      from: string;
      to: string;
      at: string;
    };

export type LabelEdit = Extract<ChunkEdit, { kind: "label" }>;

export type ChunkEditsFile = { version: 1; edits: ChunkEdit[] };

export const EMPTY_EDITS: ChunkEditsFile = { version: 1, edits: [] };

/** An edit positioned on the clock and clipped to one day. */
export type EditRange = { startMs: number; endMs: number; edit: ChunkEdit };

/** What a request asks for. Times are instants in milliseconds. */
export type EditOp =
  | {
      op: "label";
      fromMs: number;
      toMs: number;
      project: string;
      label: string;
      active: boolean;
      /** A range to forget first: the stretch being edited, so moving its edges leaves nothing of the old one behind. */
      clear?: { fromMs: number; toMs: number };
    }
  | { op: "remove"; fromMs: number; toMs: number }
  /** Forget every edit inside the range: the day there goes back to what was measured. */
  | { op: "revert"; fromMs: number; toMs: number };

/** A typed-in time this close to a real edge in the day is taken to mean that edge. */
export const SNAP_MS = 60_000;
/** Shorter than this, a stretch left over between two others is folded into its neighbour rather than drawn. */
const SLIVER_MS = 30_000;
/** A piece of an older edit shorter than this after a cut is dropped rather than kept as noise. */
const MIN_PIECE_MS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** Tolerant: a missing or damaged file is no edits, and a malformed entry is skipped. */
export function parseEditsFile(raw: string | null): ChunkEditsFile {
  if (raw === null) return EMPTY_EDITS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_EDITS;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.edits)) return EMPTY_EDITS;
  const edits: ChunkEdit[] = [];
  for (const entry of parsed.edits) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !isInstant(entry.from) || !isInstant(entry.to)) continue;
    if (Date.parse(entry.to) <= Date.parse(entry.from)) continue;
    const at = isInstant(entry.at) ? entry.at : entry.to;
    if (entry.kind === "remove") {
      edits.push({ id: entry.id, kind: "remove", from: entry.from, to: entry.to, at });
    } else if (entry.kind === "label") {
      edits.push({
        id: entry.id,
        kind: "label",
        from: entry.from,
        to: entry.to,
        project: typeof entry.project === "string" && entry.project ? entry.project : OTHER_BUCKET,
        label: typeof entry.label === "string" ? entry.label.trim() : "",
        active: entry.active === true,
        at,
      });
    }
  }
  return { version: 1, edits };
}

function dayBounds(date: string): { dayStartMs: number; dayEndMs: number } {
  const [y, m, d] = date.split("-").map(Number);
  return { dayStartMs: new Date(y, m - 1, d).getTime(), dayEndMs: new Date(y, m - 1, d + 1).getTime() };
}

/**
 * The edits that touch one local day, clipped to it, ascending and disjoint. The file is
 * kept disjoint already; if a hand-edited one overlaps, the later entry wins where they do.
 */
export function editsForDay(file: ChunkEditsFile, date: string): EditRange[] {
  const { dayStartMs, dayEndMs } = dayBounds(date);
  let ranges: EditRange[] = [];
  for (const edit of file.edits) {
    const startMs = Math.max(Date.parse(edit.from), dayStartMs);
    const endMs = Math.min(Date.parse(edit.to), dayEndMs);
    if (!(endMs > startMs)) continue;
    ranges = ranges.flatMap((range) => subtractRanges(range.startMs, range.endMs, [{ startMs, endMs }]).map((part) => ({ ...range, ...part })));
    ranges.push({ startMs, endMs, edit });
  }
  return ranges.sort((a, b) => a.startMs - b.startMs);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Cuts `[fromMs, toMs)` out of every edit. An edit split in two keeps its id on the first half. */
function cut(edits: ChunkEdit[], fromMs: number, toMs: number): ChunkEdit[] {
  return edits.flatMap((edit) => {
    const startMs = Date.parse(edit.from);
    const endMs = Date.parse(edit.to);
    if (endMs <= fromMs || startMs >= toMs) return [edit];
    return subtractRanges(startMs, endMs, [{ startMs: fromMs, endMs: toMs }])
      .filter((part) => part.endMs - part.startMs >= MIN_PIECE_MS)
      .map((part, i) => ({ ...edit, id: i === 0 ? edit.id : `${edit.id}-${i}`, from: iso(part.startMs), to: iso(part.endMs) }));
  });
}

/** The file after one request. Pure; `id` and `atIso` are the caller's so this stays deterministic. */
export function applyEditOp(file: ChunkEditsFile, op: EditOp, id: string, atIso: string): ChunkEditsFile {
  let edits = file.edits;
  if (op.op === "label" && op.clear) edits = cut(edits, op.clear.fromMs, op.clear.toMs);
  edits = cut(edits, op.fromMs, op.toMs);
  if (op.op === "label") {
    edits = [...edits, { id, kind: "label", from: iso(op.fromMs), to: iso(op.toMs), project: op.project, label: op.label.trim(), active: op.active, at: atIso }];
  } else if (op.op === "remove") {
    edits = [...edits, { id, kind: "remove", from: iso(op.fromMs), to: iso(op.toMs), at: atIso }];
  }
  return { version: 1, edits: [...edits].sort((a, b) => Date.parse(a.from) - Date.parse(b.from)) };
}

/** The nearest edge within `SNAP_MS`, or the instant itself when none is that close. */
export function snapToEdge(ms: number, edges: number[]): number {
  let best = ms;
  let bestDistance = SNAP_MS + 1;
  for (const edge of edges) {
    const distance = Math.abs(edge - ms);
    if (distance <= SNAP_MS && distance < bestDistance) {
      best = edge;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The day measured again with its edits folded in, for everything shown. `raw` is the same
 * day measured without them (what the model reads) and `sessions` the off-computer
 * sessions it was measured with.
 *
 * A stretch counted as worked joins the sessions: trusted over the screen, idle masked, one
 * fully active interval of its own. A session the person has since removed or said
 * something else about gives way where they did. A removed stretch is cut out of
 * everything and kept on the measure — clipped to what the day observed, so taking out a
 * morning nobody was at the machine for removes nothing — for the list to offer it back.
 */
export function measureWithEdits(
  date: string,
  log: AmbientLog,
  thresholdS: number,
  sessions: ManualRange[],
  edits: EditRange[],
  raw: AmbientDayMeasure,
): AmbientDayMeasure {
  const overriding = edits.filter((range) => range.edit.kind === "remove" || range.edit.active);
  const manual: ManualRange[] = [
    ...sessions.flatMap((session) => subtractRanges(session.startMs, session.endMs, overriding).map((part) => ({ ...session, ...part }))),
    ...edits.flatMap(({ startMs, endMs, edit }) => (edit.kind === "label" && edit.active ? [{ startMs, endMs, project: edit.project, note: edit.label }] : [])),
  ].sort((a, b) => a.startMs - b.startMs);
  const removed =
    raw.intervals.length === 0
      ? []
      : edits.flatMap(({ startMs, endMs, edit }) => {
          if (edit.kind !== "remove") return [];
          const from = Math.max(startMs, raw.firstMs);
          const to = Math.min(endMs, raw.lastMs);
          return to > from ? [{ startMs: from, endMs: to }] : [];
        });
  return measureDay(date, log, thresholdS, manual, removed);
}

type Tile = { startMs: number; endMs: number; chunk: AmbientChunk | null; edit: LabelEdit | null };

/**
 * The day's chunks with the edits laid over them. `raw` are the chunks as labelled from the
 * unedited day; `day` and `segments` are the edited day and its cut.
 *
 * Within each stretch of the edited day, the person's ranges take the place of whatever
 * they cover, the model's chunks keep what is left of theirs, and every piece is measured
 * again against the edited day, so a stretch counted as worked shows as worked. Pieces
 * are stitched so the stretch is covered exactly — the model's chunks stretch over any
 * uncovered edge, since that is what they would have covered had the day been cut this
 * way — and a sliver left between two others is folded into its neighbour.
 */
export function overlayEdits(raw: AmbientChunk[], edits: EditRange[], day: AmbientDayMeasure, segments: AmbientDaySegment[]): AmbientChunk[] {
  const pieces: Tile[] = [];
  for (const chunk of raw) {
    for (const part of subtractRanges(Date.parse(chunk.from), Date.parse(chunk.to), edits)) pieces.push({ ...part, chunk, edit: null });
  }
  for (const { startMs, endMs, edit } of edits) {
    if (edit.kind === "label") pieces.push({ startMs, endMs, chunk: null, edit });
  }
  pieces.sort((a, b) => a.startMs - b.startMs);

  const out: AmbientChunk[] = [];
  for (const segment of segments) {
    if (segment.kind !== "candidate") continue;
    const segStart = Date.parse(segment.from);
    const segEnd = Date.parse(segment.to);
    for (const tile of stitch(pieces, segStart, segEnd)) {
      const measured = measureSpan(day, tile.startMs, tile.endMs);
      const from = toLocalIso(new Date(tile.startMs));
      const to = toLocalIso(new Date(tile.endMs));
      if (tile.edit) {
        const edit = tile.edit;
        const projects = [{ project: edit.project, from, to, ...measured }];
        out.push({ from, to, label: edit.label, project: edit.project, projects, what: "", evidence: [], unclear: false, ...measured, candidate: segment.index, edit: { active: edit.active } });
      } else if (tile.chunk) {
        // A piece of a chunk gets the piece of its ledger, measured again against the edited
        // day: a stretch the person counted as worked is worked on whichever project held it.
        const projects = clipProjects(tile.chunk, day, tile.startMs, tile.endMs);
        out.push({ ...tile.chunk, from, to, ...measured, projects, candidate: segment.index });
      } else {
        const projects = [{ project: OTHER_BUCKET, from, to, ...measured }];
        out.push({ from, to, label: null, project: OTHER_BUCKET, projects, what: "", evidence: [], unclear: true, ...measured, candidate: segment.index });
      }
    }
  }
  return out;
}

/**
 * A chunk's ledger clipped to a piece of it. A chunk cached before the ledger existed has
 * none, and the piece takes the chunk's own project, exactly as the old reading did.
 */
function clipProjects(chunk: AmbientChunk, day: AmbientDayMeasure, startMs: number, endMs: number): AmbientProjectSplit[] {
  const lines = chunk.projects?.length ? chunk.projects : [{ project: chunk.project, from: chunk.from, to: chunk.to }];
  const out: AmbientProjectSplit[] = [];
  for (const line of lines) {
    const fromMs = Math.max(startMs, Date.parse(line.from));
    const toMs = Math.min(endMs, Date.parse(line.to));
    if (!(toMs > fromMs)) continue;
    out.push({ project: line.project, from: toLocalIso(new Date(fromMs)), to: toLocalIso(new Date(toMs)), ...measureSpan(day, fromMs, toMs) });
  }
  if (out.length > 0) return out;
  return [{ project: chunk.project, from: toLocalIso(new Date(startMs)), to: toLocalIso(new Date(endMs)), ...measureSpan(day, startMs, endMs) }];
}

/** The pieces inside `[segStart, segEnd)`, covering it exactly. */
function stitch(pieces: Tile[], segStart: number, segEnd: number): Tile[] {
  const tiles: Tile[] = [];
  let cursor = segStart;
  for (const piece of pieces) {
    const startMs = Math.max(piece.startMs, cursor, segStart);
    const endMs = Math.min(piece.endMs, segEnd);
    if (endMs <= startMs) continue;
    if (startMs > cursor) fill(tiles, cursor, startMs, piece);
    tiles.push({ ...piece, startMs, endMs });
    cursor = endMs;
  }
  if (cursor < segEnd) fill(tiles, cursor, segEnd, null);

  // Slivers go to a neighbour; then neighbours that are the same chunk or edit rejoin.
  for (let i = 0; i < tiles.length && tiles.length > 1; ) {
    if (tiles[i].endMs - tiles[i].startMs >= SLIVER_MS) {
      i++;
      continue;
    }
    if (i > 0) tiles[i - 1].endMs = tiles[i].endMs;
    else tiles[1].startMs = tiles[0].startMs;
    tiles.splice(i, 1);
  }
  const merged: Tile[] = [];
  for (const tile of tiles) {
    const last = merged[merged.length - 1];
    if (last && sameSource(last, tile)) {
      last.endMs = tile.endMs;
      continue;
    }
    merged.push(tile);
  }
  return merged;
}

function sameSource(a: Tile, b: Tile): boolean {
  if (a.edit || b.edit) return a.edit?.id === b.edit?.id;
  return a.chunk === b.chunk;
}

/** Covers a gap inside a stretch: the model's chunk before it stretches over it, else the one after, else it stands unlabelled. */
function fill(tiles: Tile[], startMs: number, endMs: number, next: Tile | null): void {
  const previous = tiles[tiles.length - 1];
  if (previous && previous.edit === null && previous.chunk !== null) {
    previous.endMs = endMs;
    return;
  }
  if (next && next.edit === null && next.chunk !== null) {
    tiles.push({ ...next, startMs, endMs });
    return;
  }
  tiles.push({ startMs, endMs, chunk: null, edit: null });
}
