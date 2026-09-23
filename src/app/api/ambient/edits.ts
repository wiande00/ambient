import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyEditOp, EMPTY_EDITS, parseEditsFile, type ChunkEditsFile, type EditOp } from "@/lib/ambient/edits";
import { ambientDir } from "./store";

/**
 * Reads and writes `~/.ambient/edits.json`, every correction the person has made to a day
 * (`lib/ambient/edits.ts`). Small, whole-file, write-then-rename, and one writer at a time
 * so a click on the dashboard and a call from Claude a moment apart cannot drop each
 * other's edit. Days are measured with these applied, so `days.ts` keys its cache on this
 * file's mtime as well.
 */

export function editsPath(): string {
  return join(ambientDir(), "edits.json");
}

export async function editsMtime(): Promise<number> {
  try {
    return (await stat(editsPath())).mtimeMs;
  } catch {
    return 0;
  }
}

export async function readEdits(): Promise<ChunkEditsFile> {
  try {
    return parseEditsFile(await readFile(editsPath(), "utf8"));
  } catch {
    return EMPTY_EDITS;
  }
}

async function writeEdits(file: ChunkEditsFile): Promise<void> {
  await mkdir(ambientDir(), { recursive: true });
  const target = editsPath();
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

let chain: Promise<unknown> = Promise.resolve();

/** Applies one request to the file as it is on disk when its turn comes, and returns the result. */
export function updateEdits(op: EditOp): Promise<ChunkEditsFile> {
  const next = chain
    .catch(() => undefined)
    .then(async () => {
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const updated = applyEditOp(await readEdits(), op, id, new Date().toISOString());
      await writeEdits(updated);
      return updated;
    });
  chain = next;
  return next;
}
