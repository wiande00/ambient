import { measureSpan, type AmbientChunk, type AmbientDaySegment, type AmbientProjectSplit } from "./chunks";
import { measureDay, round1, type AmbientDayMeasure } from "./intervals";
import { subtractRanges, type ManualRange } from "./offComputer";
import { currentProjectKey, OTHER_BUCKET } from "./projects";
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

/**
 * Minutes of a stretch that went to another project than its own: ten minutes on a course
 * inside an hour of thesis work. An add-on has no place on the clock — the person knows how
 * long, not when — so it is a share, not a range. It is taken out of the stretch's active
 * minutes, never added on top: it moves time between projects and leaves every total of the
 * day as it was.
 */
export type AddOn = { project: string; minutes: number };

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
      /** Time inside the stretch that went to other projects; one per project, never `project` itself. */
      addOns?: AddOn[];
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
      addOns?: AddOn[];
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
      const project = typeof entry.project === "string" && entry.project ? currentProjectKey(entry.project) : OTHER_BUCKET;
      const addOns = normaliseAddOns(entry.addOns, project);
      edits.push({
        id: entry.id,
        kind: "label",
        from: entry.from,
        to: entry.to,
        project,
        label: typeof entry.label === "string" ? entry.label.trim() : "",
        active: entry.active === true,
        ...(addOns.length > 0 ? { addOns } : {}),
        at,
      });
    }
  }
  return { version: 1, edits };
}

/**
 * Add-ons as the file keeps them: one per project, never the stretch's own, each a positive
 * number of minutes. Anything else in the list is dropped, so a hand-edited file cannot
 * make a stretch give time to itself or take back more than it was given.
 */
export function normaliseAddOns(value: unknown, project: string): AddOn[] {
  if (!Array.isArray(value)) return [];
  const byProject = new Map<string, number>();
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.project !== "string" || !entry.project.trim()) continue;
    if (typeof entry.minutes !== "number" || !Number.isFinite(entry.minutes) || entry.minutes <= 0) continue;
    const key = currentProjectKey(entry.project.trim());
    if (key === project) continue;
    byProject.set(key, (byProject.get(key) ?? 0) + entry.minutes);
  }
  return [...byProject].map(([key, minutes]) => ({ project: key, minutes: round1(minutes) })).filter((addOn) => addOn.minutes > 0);
}

/**
 * An edit cut down to `share` of its length. Its add-ons have no place on the clock, so they
 * shrink with it in proportion: the fairest reading of "ten minutes somewhere in this hour"
 * when half the hour is taken away.
 */
function shrinkAddOns(edit: ChunkEdit, share: number): ChunkEdit {
  if (edit.kind !== "label" || !edit.addOns || share >= 1) return edit;
  const addOns = edit.addOns.map((addOn) => ({ ...addOn, minutes: round1(addOn.minutes * share) })).filter((addOn) => addOn.minutes > 0);
  return { ...edit, addOns: addOns.length > 0 ? addOns : undefined };
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

/**
 * Cuts `[fromMs, toMs)` out of every edit. An edit split in two keeps its id on the first
 * half; each piece keeps its share of the add-ons.
 */
function cut(edits: ChunkEdit[], fromMs: number, toMs: number): ChunkEdit[] {
  return edits.flatMap((edit) => {
    const startMs = Date.parse(edit.from);
    const endMs = Date.parse(edit.to);
    if (endMs <= fromMs || startMs >= toMs) return [edit];
    return subtractRanges(startMs, endMs, [{ startMs: fromMs, endMs: toMs }])
      .filter((part) => part.endMs - part.startMs >= MIN_PIECE_MS)
      .map((part, i) =>
        shrinkAddOns({ ...edit, id: i === 0 ? edit.id : `${edit.id}-${i}`, from: iso(part.startMs), to: iso(part.endMs) }, (part.endMs - part.startMs) / (endMs - startMs)),
      );
  });
}

/** The file after one request. Pure; `id` and `atIso` are the caller's so this stays deterministic. */
export function applyEditOp(file: ChunkEditsFile, op: EditOp, id: string, atIso: string): ChunkEditsFile {
  let edits = file.edits;
  if (op.op === "label" && op.clear) edits = cut(edits, op.clear.fromMs, op.clear.toMs);
  edits = cut(edits, op.fromMs, op.toMs);
  if (op.op === "label") {
    const addOns = normaliseAddOns(op.addOns, op.project);
    edits = [
      ...edits,
      {
        id,
        kind: "label",
        from: iso(op.fromMs),
        to: iso(op.toMs),
        project: op.project,
        label: op.label.trim(),
        active: op.active,
        ...(addOns.length > 0 ? { addOns } : {}),
        at: atIso,
      },
    ];
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

  const placed: { candidate: number; tile: Tile }[] = [];
  for (const segment of segments) {
    if (segment.kind !== "candidate") continue;
    for (const tile of stitch(pieces, Date.parse(segment.from), Date.parse(segment.to))) placed.push({ candidate: segment.index, tile });
  }
  const shares = addOnShares(
    placed.map(({ tile }) => tile),
    edits,
  );

  const out: AmbientChunk[] = [];
  for (const { candidate, tile } of placed) {
    const measured = measureSpan(day, tile.startMs, tile.endMs);
    const from = toLocalIso(new Date(tile.startMs));
    const to = toLocalIso(new Date(tile.endMs));
    if (tile.edit) {
      const edit = tile.edit;
      const projects = editLedger(edit, from, to, measured, shares.get(tile) ?? 1);
      out.push({ from, to, label: edit.label, project: edit.project, projects, what: "", evidence: [], unclear: false, ...measured, candidate, edit: { active: edit.active } });
    } else if (tile.chunk) {
      // A piece of a chunk gets the piece of its ledger, measured again against the edited
      // day: a stretch the person counted as worked is worked on whichever project held it.
      const projects = clipProjects(tile.chunk, day, tile.startMs, tile.endMs);
      out.push({ ...tile.chunk, from, to, ...measured, projects, candidate });
    } else {
      const projects = [{ project: OTHER_BUCKET, from, to, ...measured }];
      out.push({ from, to, label: null, project: OTHER_BUCKET, projects, what: "", evidence: [], unclear: true, ...measured, candidate });
    }
  }
  return out;
}

/**
 * How much of its add-ons each card drawn from an edit carries. Almost always one card and
 * all of them. An edit the day's breaks cut into several cards spreads its add-ons over them
 * by length, so the minutes the person gave are counted once, not once per card; one that
 * runs past midnight keeps on each day only that day's part.
 */
function addOnShares(tiles: Tile[], edits: EditRange[]): Map<Tile, number> {
  const drawnMs = new Map<LabelEdit, number>();
  for (const tile of tiles) {
    if (tile.edit?.addOns) drawnMs.set(tile.edit, (drawnMs.get(tile.edit) ?? 0) + tile.endMs - tile.startMs);
  }
  const onDayMs = new Map<ChunkEdit, number>();
  for (const { startMs, endMs, edit } of edits) onDayMs.set(edit, (onDayMs.get(edit) ?? 0) + endMs - startMs);

  const shares = new Map<Tile, number>();
  for (const tile of tiles) {
    const edit = tile.edit;
    if (!edit?.addOns) continue;
    const wholeMs = Date.parse(edit.to) - Date.parse(edit.from);
    const dayShare = Math.min(1, (onDayMs.get(edit) ?? wholeMs) / wholeMs);
    shares.set(tile, (dayShare * (tile.endMs - tile.startMs)) / (drawnMs.get(edit) ?? tile.endMs - tile.startMs));
  }
  return shares;
}

/**
 * An edited card's ledger: its own project over the whole stretch, less the add-ons, which
 * follow as lines of their own. An add-on line is all active and sits at the stretch's end
 * with no length (`AmbientProjectSplit.addOn`), so nothing that measures the clock — threads,
 * the longest stretch on one project — counts its minutes twice. The add-ons never take more
 * than the stretch worked; asked for more, they are scaled down to fit.
 */
function editLedger(
  edit: LabelEdit,
  from: string,
  to: string,
  measured: { minutes: number; activeMinutes: number; idleMinutes: number },
  share: number,
): AmbientProjectSplit[] {
  const own: AmbientProjectSplit = { project: edit.project, from, to, ...measured };
  if (!edit.addOns?.length) return [own];
  const wanted = edit.addOns.map((addOn) => ({ project: addOn.project, minutes: addOn.minutes * share }));
  const total = wanted.reduce((sum, addOn) => sum + addOn.minutes, 0);
  const fits = total <= measured.activeMinutes;
  // Rounded down when scaled, so the lines can never add up to more than the stretch worked.
  const lines = wanted
    .map((addOn) => ({ ...addOn, minutes: fits ? round1(addOn.minutes) : Math.floor((addOn.minutes * measured.activeMinutes * 10) / total) / 10 }))
    .filter((addOn) => addOn.minutes > 0);
  const taken = lines.reduce((sum, addOn) => sum + addOn.minutes, 0);
  return [
    { ...own, minutes: round1(Math.max(0, measured.minutes - taken)), activeMinutes: round1(Math.max(0, measured.activeMinutes - taken)) },
    ...lines.map((addOn) => ({ project: addOn.project, from: to, to, minutes: addOn.minutes, activeMinutes: addOn.minutes, idleMinutes: 0, addOn: true as const })),
  ];
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
