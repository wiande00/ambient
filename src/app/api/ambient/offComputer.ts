import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EMPTY_OFF_COMPUTER, parseOffComputerFile, type OffComputerFile, type OffComputerSession } from "@/lib/ambient/offComputer";
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

export function activeSession(file: OffComputerFile): OffComputerSession | null {
  return file.sessions.find((session) => session.to === null) ?? null;
}

/** Starts a session now, closing any that was still open. */
export async function startOffComputer(project: string, note: string): Promise<OffComputerSession> {
  const file = await readOffComputer();
  const now = new Date().toISOString();
  const closed = file.sessions.map((session) => (session.to === null ? { ...session, to: now } : session));
  const session: OffComputerSession = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, from: now, to: null, project, note: note.trim() };
  await writeOffComputer({ version: 1, sessions: [...closed, session] });
  return session;
}

/** Ends the open session, if there is one. */
export async function stopOffComputer(): Promise<OffComputerSession | null> {
  const file = await readOffComputer();
  const open = activeSession(file);
  if (!open) return null;
  const ended = { ...open, to: new Date().toISOString() };
  await writeOffComputer({ version: 1, sessions: file.sessions.map((session) => (session.id === open.id ? ended : session)) });
  return ended;
}
