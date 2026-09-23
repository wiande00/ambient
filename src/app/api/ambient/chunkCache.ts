import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AmbientChunk, ChunkPart } from "@/lib/ambient/chunks";
import type { AmbientLabelUsage } from "@/lib/ambient/types";
import { ambientDir } from "./store";

/**
 * The on-disk cache of labels, one file per day under `~/.ambient/chunks/`. Labels are
 * kept per candidate, keyed on a hash of exactly what the model was shown for it, so a
 * stretch of the day is paid for once and only what has changed goes back to the model.
 * The last assembled view is kept alongside, for the week route and the MCP server to
 * total per project without a model call. Version-stamped so an older shape is a miss,
 * never a crash.
 */

/** One candidate's answer. `parts: null` records a rejected answer, so it is not retried on every tick. */
export type CachedLabel = {
  parts: ChunkPart[] | null;
  generatedAt: string;
  model: string;
  /** Rejected answers for this exact key so far; the route stops retrying after a few. */
  attempts: number;
};

/** One model call, for the day's audit trail. */
export type CachedCall = {
  at: string;
  candidates: number;
  input_tokens: number;
  output_tokens: number;
  estimated_usd: number;
};

export type CachedChunks = {
  version: 4;
  generatedAt: string;
  model: string;
  /** Hash of the candidate keys and sessions the `chunks` below were assembled from; a match means they are current. */
  chunksKey: string;
  chunks: AmbientChunk[];
  labels: Record<string, CachedLabel>;
  usage: AmbientLabelUsage;
  /** Most recent calls, oldest first, capped. */
  calls: CachedCall[];
};

/** The previous shape: one whole-day answer. Read only to salvage its labels into version 4. */
export type LegacyCachedChunks = { version: 3; chunks: AmbientChunk[] };

export const MAX_CALLS_KEPT = 50;

export const EMPTY_USAGE: AmbientLabelUsage = {
  calls: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  estimated_usd: 0,
};

function cachePath(date: string): string {
  return join(ambientDir(), "chunks", `${date}.json`);
}

/** A missing, unreadable, or malformed file all resolve to `null` — a corrupt cache is a miss to regenerate, never an error. */
export async function readChunkCache(date: string): Promise<CachedChunks | LegacyCachedChunks | null> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(date), "utf8")) as Partial<CachedChunks> | Partial<LegacyCachedChunks>;
    if (!Array.isArray(parsed.chunks)) return null;
    if (parsed.version === 4 && typeof parsed.chunksKey === "string" && parsed.labels && typeof parsed.labels === "object") {
      return { ...parsed, usage: { ...EMPTY_USAGE, ...(parsed.usage ?? {}) }, calls: Array.isArray(parsed.calls) ? parsed.calls : [] } as CachedChunks;
    }
    if (parsed.version === 3) return { version: 3, chunks: parsed.chunks };
    return null;
  } catch {
    return null;
  }
}

/** Write-then-rename so a reader never sees a half-written file; a write failure is swallowed since the caller still has the fresh chunks. */
async function writeChunkCache(date: string, entry: CachedChunks): Promise<void> {
  try {
    await mkdir(join(ambientDir(), "chunks"), { recursive: true });
    const target = cachePath(date);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(entry), "utf8");
    await rename(tmp, target);
  } catch {
    // The response still carries the chunks even if they never land on disk.
  }
}

/** One chain of pending updates per date, so two writers take turns instead of racing. */
const chains = new Map<string, Promise<unknown>>();

/**
 * Read-modify-write under a per-date queue. A background label merge and a request's view
 * rewrite can land seconds apart; each sees the file as the other left it, so neither
 * clobbers the other's labels. `mutate` returning null leaves the file untouched.
 */
export async function updateChunkCache(
  date: string,
  mutate: (current: CachedChunks | LegacyCachedChunks | null) => CachedChunks | null,
): Promise<CachedChunks | null> {
  const previous = chains.get(date) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const current = await readChunkCache(date);
      const updated = mutate(current);
      if (updated) await writeChunkCache(date, updated);
      return updated;
    });
  chains.set(date, next);
  try {
    return await next;
  } finally {
    if (chains.get(date) === next) chains.delete(date);
  }
}
