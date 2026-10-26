/**
 * Working off the computer: pen and paper, a book, a whiteboard. The collector cannot see
 * it, so the person says so with a switch, and the stretch is recorded here as a session
 * with a project and an optional note. Pure: parsing, clipping to a day, and the range
 * arithmetic `measureDay` needs to fold a session into the measured day. Reading and
 * writing the file is `app/api/ambient/offComputer.ts`.
 *
 * A session is trusted over the screen: while it runs, the time counts as active work on
 * its project whatever window is in front and however long the keyboard is untouched.
 *
 * A session can be given a stop time when it starts, or while it runs. It ends there on its
 * own: nothing writes the file at that moment, so every reader works the end out with
 * `sessionEndMs` instead of trusting `to` alone.
 */

import { currentProjectKey, OTHER_BUCKET } from "./projects";

export type OffComputerSession = {
  id: string;
  /** UTC ISO. */
  from: string;
  /** UTC ISO, or null while the session is still running. */
  to: string | null;
  /** A project key or a fallback bucket. */
  project: string;
  /** What, in a few words. May be empty. */
  note: string;
  /** UTC ISO: when a running session stops on its own. Absent when it runs until turned off. */
  until?: string;
};

export type OffComputerFile = { version: 1; sessions: OffComputerSession[] };

/** A session positioned on the clock, clipped to one day. */
export type ManualRange = { startMs: number; endMs: number; project: string; note: string };

/** The app name a session takes inside the measured day, so nothing mistakes it for a window. */
export const OFF_COMPUTER_APP = "off-computer";

export const EMPTY_OFF_COMPUTER: OffComputerFile = { version: 1, sessions: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tolerant: a missing or damaged file is no sessions, and a malformed entry is skipped. */
export function parseOffComputerFile(raw: string | null): OffComputerFile {
  if (raw === null) return EMPTY_OFF_COMPUTER;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_OFF_COMPUTER;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) return EMPTY_OFF_COMPUTER;
  const sessions: OffComputerSession[] = [];
  for (const entry of parsed.sessions) {
    if (!isRecord(entry)) continue;
    if (typeof entry.id !== "string" || typeof entry.from !== "string" || !Number.isFinite(new Date(entry.from).getTime())) continue;
    const to = typeof entry.to === "string" && Number.isFinite(new Date(entry.to).getTime()) ? entry.to : null;
    const until = typeof entry.until === "string" && Number.isFinite(new Date(entry.until).getTime()) ? entry.until : null;
    sessions.push({
      id: entry.id,
      from: entry.from,
      to,
      project: typeof entry.project === "string" && entry.project ? currentProjectKey(entry.project) : OTHER_BUCKET,
      note: typeof entry.note === "string" ? entry.note.trim() : "",
      ...(until ? { until } : {}),
    });
  }
  return { version: 1, sessions };
}

/** When a session ended: `to`, or for one still open its stop time if that has passed, else `nowMs`. */
export function sessionEndMs(session: OffComputerSession, nowMs: number): number {
  if (session.to !== null) return new Date(session.to).getTime();
  return session.until ? Math.min(nowMs, new Date(session.until).getTime()) : nowMs;
}

/** Still counting: never turned off, and not yet at its stop time. */
export function isRunning(session: OffComputerSession, nowMs: number): boolean {
  return session.to === null && (!session.until || new Date(session.until).getTime() > nowMs);
}

/** The session as it stands at `nowMs`: one that ran out has `to` set to its stop time. */
export function settledSession(session: OffComputerSession, nowMs: number): OffComputerSession {
  return session.to === null && !isRunning(session, nowMs) ? { ...session, to: session.until ?? null } : session;
}

/**
 * The next time the local clock reads `hhmm` ("17:00"): later today, or tomorrow once
 * today's has passed. Null for anything that is not a clock time.
 */
export function nextClockTime(hhmm: string, nowMs: number): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const now = new Date(nowMs);
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
  if (at.getTime() <= nowMs) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** The sessions that touch one local day, clipped to it; an open session runs to `nowMs` or its stop time. Ascending, non-overlapping. */
export function rangesForDay(file: OffComputerFile, date: string, nowMs: number): ManualRange[] {
  const [y, m, d] = date.split("-").map(Number);
  const dayStartMs = new Date(y, m - 1, d).getTime();
  const dayEndMs = new Date(y, m - 1, d + 1).getTime();
  const out: ManualRange[] = [];
  for (const session of file.sessions) {
    const startMs = Math.max(new Date(session.from).getTime(), dayStartMs);
    const endMs = Math.min(sessionEndMs(session, nowMs), dayEndMs);
    if (endMs > startMs) out.push({ startMs, endMs, project: session.project, note: session.note });
  }
  out.sort((a, b) => a.startMs - b.startMs);
  // Sessions are started one at a time, but a hand-edited file could overlap them.
  const merged: ManualRange[] = [];
  for (const range of out) {
    const last = merged[merged.length - 1];
    if (last && range.startMs < last.endMs) last.endMs = Math.max(last.endMs, range.endMs);
    else merged.push({ ...range });
  }
  return merged;
}

/** The parts of `[startMs, endMs)` that no hole covers, in order. Holes must be ascending and non-overlapping. */
export function subtractRanges(startMs: number, endMs: number, holes: { startMs: number; endMs: number }[]): { startMs: number; endMs: number }[] {
  const out: { startMs: number; endMs: number }[] = [];
  let cursor = startMs;
  for (const hole of holes) {
    if (hole.endMs <= cursor) continue;
    if (hole.startMs >= endMs) break;
    if (hole.startMs > cursor) out.push({ startMs: cursor, endMs: hole.startMs });
    cursor = Math.max(cursor, hole.endMs);
  }
  if (cursor < endMs) out.push({ startMs: cursor, endMs });
  return out;
}

/** The sentence a session's chunk carries. Written here, never by the model. */
export function offComputerLabel(note: string): string {
  return note ? `Worked off the computer: ${note}.` : "Worked off the computer.";
}
