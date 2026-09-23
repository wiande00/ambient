import { NextResponse } from "next/server";
import { daySegments } from "@/lib/ambient/chunks";
import { snapToEdge, type ChunkEditsFile, type EditOp } from "@/lib/ambient/edits";
import { FALLBACK_BUCKETS, isFallbackBucket } from "@/lib/ambient/projects";
import type { AmbientEditsResponse } from "@/lib/ambient/types";
import { readChunkCache } from "../chunkCache";
import { loadConfig } from "../config";
import { loadDay, withEdits } from "../days";
import { readEdits, updateEdits } from "../edits";
import { loadProjects } from "../projects";
import { isValidDateStamp, todayStamp } from "../store";

export const runtime = "nodejs";

/**
 * The person's corrections to a day's chunks (`lib/ambient/edits.ts`). `GET ?date=` lists
 * the edits touching that day. `PUT` makes one:
 *
 * - `{date, op: "label", from, to, project, label, active, clear?}` says what `from`–`to`
 *   was, overriding the model there; `active` counts all of it as worked; `clear` is the
 *   stretch being edited, forgotten first so moving its edges leaves nothing behind.
 * - `{date, op: "remove", from, to}` takes the stretch out of the day.
 * - `{date, op: "revert", from, to}` forgets every edit inside it.
 *
 * Times are instants. A typed time within a minute of a real edge in the day — a chunk's,
 * a break's, a gap's — is taken to mean that edge, so a stretch edited to "10:47" does not
 * leave a sliver of the chunk that really ended at 10:47:55. Nothing is sent to the model:
 * the day is re-measured with the edit on its next load.
 */

function dayBounds(date: string): { dayStartMs: number; dayEndMs: number } {
  const [y, m, d] = date.split("-").map(Number);
  return { dayStartMs: new Date(y, m - 1, d).getTime(), dayEndMs: new Date(y, m - 1, d + 1).getTime() };
}

function forDay(file: ChunkEditsFile, date: string): AmbientEditsResponse {
  const { dayStartMs, dayEndMs } = dayBounds(date);
  return {
    status: "ready",
    date,
    edits: file.edits.filter((edit) => Date.parse(edit.to) > dayStartMs && Date.parse(edit.from) < dayEndMs),
  };
}

function bad(message: string, status = 400) {
  return NextResponse.json({ status: "error", message } satisfies AmbientEditsResponse, { status });
}

export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get("date");
  if (requested !== null && !isValidDateStamp(requested)) return bad("Invalid date.");
  try {
    return NextResponse.json(forDay(await readEdits(), requested ?? todayStamp()));
  } catch (error) {
    return NextResponse.json({ status: "error", message: error instanceof Error ? error.message : "Failed to load." } satisfies AmbientEditsResponse);
  }
}

type Body = {
  date?: unknown;
  op?: unknown;
  from?: unknown;
  to?: unknown;
  project?: unknown;
  label?: unknown;
  active?: unknown;
  clear?: unknown;
};

const MAX_LABEL_CHARS = 300;
const MIN_STRETCH_MS = 60_000;

function instant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export async function PUT(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return bad("Expected JSON.", 415);
  let body: Body;
  try {
    const parsed: unknown = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Body) : {};
  } catch {
    return bad("The body is not valid JSON.");
  }

  const date = typeof body.date === "string" && isValidDateStamp(body.date) ? body.date : null;
  if (!date) return bad("Expected date as YYYY-MM-DD.");
  if (body.op !== "label" && body.op !== "remove" && body.op !== "revert") return bad('Expected op: "label", "remove" or "revert".');
  const op = body.op;
  const rawFrom = instant(body.from);
  const rawTo = instant(body.to);
  if (rawFrom === null || rawTo === null) return bad("Expected from and to as ISO instants.");

  const { dayStartMs, dayEndMs } = dayBounds(date);
  if (rawFrom >= dayEndMs || rawTo <= dayStartMs) return bad(`The stretch has to fall on ${date}.`);

  try {
    const { config } = await loadConfig();
    const [day, cache] = await Promise.all([loadDay(date, config.afkSeconds), readChunkCache(date)]);

    // The edges a typed time may mean: every chunk's as the screen shows them, and every
    // candidate's, break's and gap's.
    const edges: number[] = [dayStartMs, dayEndMs];
    if (day) {
      for (const segment of daySegments(day.edited, config.breakMinutes)) edges.push(Date.parse(segment.from), Date.parse(segment.to));
      for (const chunk of cache ? withEdits(cache.chunks, day, config.breakMinutes) : []) edges.push(Date.parse(chunk.from), Date.parse(chunk.to));
    }
    const fromMs = Math.max(dayStartMs, snapToEdge(rawFrom, edges));
    let toMs = Math.min(dayEndMs, snapToEdge(rawTo, edges));

    if (op !== "revert") {
      // Time that has not happened yet cannot have been worked; a stretch running on into
      // the future ends now.
      const nowMs = Date.now();
      if (fromMs >= nowMs) return bad("The stretch starts in the future.");
      toMs = Math.min(toMs, nowMs);
      if (toMs - fromMs < MIN_STRETCH_MS) return bad("The stretch has to be at least a minute long, and end after it starts.");
    } else if (toMs <= fromMs) {
      return bad("The end has to be after the start.");
    }

    let edit: EditOp;
    if (op === "label") {
      const project = typeof body.project === "string" && body.project.trim() ? body.project.trim() : "other";
      const projects = await loadProjects();
      if (!isFallbackBucket(project) && !projects.file.projects.some((p) => p.key === project)) {
        const known = [...projects.file.projects.map((p) => p.key), ...FALLBACK_BUCKETS].join(", ");
        return bad(`Unknown project "${project}". Known: ${known}.`);
      }
      const label = typeof body.label === "string" ? body.label.trim().replace(/\s+/g, " ") : "";
      if (!label) return bad("Say what the stretch was: a sentence is needed.");
      if (label.length > MAX_LABEL_CHARS) return bad(`Keep the sentence under ${MAX_LABEL_CHARS} characters.`);
      const clear = body.clear && typeof body.clear === "object" ? (body.clear as { from?: unknown; to?: unknown }) : null;
      const clearFrom = clear ? instant(clear.from) : null;
      const clearTo = clear ? instant(clear.to) : null;
      edit = {
        op,
        fromMs,
        toMs,
        project,
        label,
        active: body.active === true,
        ...(clearFrom !== null && clearTo !== null && clearTo > clearFrom ? { clear: { fromMs: clearFrom, toMs: clearTo } } : {}),
      };
    } else {
      edit = { op, fromMs, toMs };
    }

    return NextResponse.json(forDay(await updateEdits(edit), date));
  } catch (error) {
    return NextResponse.json({ status: "error", message: error instanceof Error ? error.message : "Failed to save." } satisfies AmbientEditsResponse);
  }
}
