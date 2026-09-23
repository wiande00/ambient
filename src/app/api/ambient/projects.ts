import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EMPTY_PROJECTS, parseProjectsFile, type AmbientProjectsFile } from "@/lib/ambient/projects";
import { ambientDir } from "./store";

/**
 * Reads and writes `~/.ambient/projects.json`. A missing file is simply no projects — every
 * chunk lands in a bucket. A malformed one is reported, not swallowed: the person edited it
 * by hand and would rather hear that a key is wrong than watch a project's hours disappear.
 * The Settings screen writes it through the projects route; the file stays hand-editable.
 */

/** Write-then-rename, so a request reading the file mid-save never sees half of it. */
export async function saveProjects(file: AmbientProjectsFile): Promise<void> {
  await mkdir(ambientDir(), { recursive: true });
  const target = projectsPath();
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

export function projectsPath(): string {
  return join(ambientDir(), "projects.json");
}

export type LoadedProjects = {
  file: AmbientProjectsFile;
  /** The raw text, for the cache key: any edit to the file changes every day's labels. */
  raw: string;
  /** Set when the file exists but could not be used. */
  error: string | null;
};

export async function loadProjects(): Promise<LoadedProjects> {
  let raw: string;
  try {
    raw = await readFile(projectsPath(), "utf8");
  } catch {
    return { file: EMPTY_PROJECTS, raw: "", error: null };
  }
  try {
    return { file: parseProjectsFile(raw), raw, error: null };
  } catch (error) {
    return {
      file: EMPTY_PROJECTS,
      raw: "",
      error: error instanceof Error ? error.message : "projects.json could not be read.",
    };
  }
}
