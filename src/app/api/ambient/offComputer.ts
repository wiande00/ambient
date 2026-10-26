import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EMPTY_OFF_COMPUTER,
  isRunning,
  parseOffComputerFile,
  sessionEndMs,
  type OffComputerFile,
  type OffComputerSession,
} from "@/lib/ambient/offComputer";
import { ambientDir } from "./store";

/**
 * Reads and writes `~/.ambient/offcomputer.json`, the record of every "working off the
 * computer" session. Small, whole-file, write-then-rename. Days are measured with these
 * folded in, so `days.ts` keys its cache on this file's mtime as well as the log's.
 */

export function offComputerPath(): string {
  return join(ambientDir(), "offcomputer.json");
}

export async function offComputerMtime(): Promise<number> {
  try {
    return (await stat(offComputerPath())).mtimeMs;
  } catch {
    return 0;
  }
}

export async function readOffComputer(): Promise<OffComputerFile> {
  try {
    return parseOffComputerFile(await readFile(offComputerPath(), "utf8"));
  } catch {
    return EMPTY_OFF_COMPUTER;
  }
}

async function writeOffComputer(file: OffComputerFile): Promise<void> {
  await mkdir(ambientDir(), { recursive: true });
  const target = offComputerPath();
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

/** The session still counting, if any. One past its stop time has ended, whatever `to` says. */
export function activeSession(file: OffComputerFile, nowMs = Date.now()): OffComputerSession | null {
  return file.sessions.find((session) => isRunning(session, nowMs)) ?? null;
}

/**
 * Closes whatever is still open: at its stop time when that has passed, so a session that
 * ran out is written down where it ended rather than when someone next touched the switch.
 */
function closeOpen(sessions: OffComputerSession[], nowMs: number): OffComputerSession[] {
  return sessions.map((session) => (session.to === null ? { ...session, to: new Date(sessionEndMs(session, nowMs)).toISOString() } : session));
}

/** Starts a session now, closing any that was still open. `untilMs`, when set, is when it stops on its own. */
export async function startOffComputer(project: string, note: string, untilMs: number | null = null): Promise<OffComputerSession> {
  const file = await readOffComputer();
  const nowMs = Date.now();
  const session: OffComputerSession = {
    id: `${nowMs.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    from: new Date(nowMs).toISOString(),
    to: null,
    project,
    note: note.trim(),
    ...(untilMs !== null ? { until: new Date(untilMs).toISOString() } : {}),
  };
  await writeOffComputer({ version: 1, sessions: [...closeOpen(file.sessions, nowMs), session] });
  return session;
}

/** Ends the open session, if there is one: now, or at its stop time if that has already passed. */
export async function stopOffComputer(): Promise<OffComputerSession | null> {
  const file = await readOffComputer();
  const nowMs = Date.now();
  if (!file.sessions.some((session) => session.to === null)) return null;
  const sessions = closeOpen(file.sessions, nowMs);
  await writeOffComputer({ version: 1, sessions });
  return sessions.find((session, i) => file.sessions[i].to === null) ?? null;
}

/** Gives the running session a stop time, or takes it away with null. Null when nothing is running. */
export async function setOffComputerUntil(untilMs: number | null): Promise<OffComputerSession | null> {
  const file = await readOffComputer();
  const running = activeSession(file);
  if (!running) return null;
  const { until, ...rest } = running;
  void until;
  const next: OffComputerSession = untilMs === null ? rest : { ...rest, until: new Date(untilMs).toISOString() };
  await writeOffComputer({ version: 1, sessions: file.sessions.map((session) => (session.id === running.id ? next : session)) });
  return next;
}
