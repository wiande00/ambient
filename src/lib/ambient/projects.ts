/**
 * The projects a person's hours get totalled against. A small list they maintain by hand in
 * `~/.ambient/projects.json` (a committed example sits at the repo root); each chunk of the
 * day is assigned exactly one project key, or one of the fixed buckets below when the work
 * belonged to no project — shopping, a job search, a game.
 *
 * Pure: parsing and validation only. Loading the file is `app/api/ambient/projects.ts`.
 */

export type AmbientProject = {
  /** Stable identifier, `^[a-z0-9-]+$`. What chunks and caches refer to. */
  key: string;
  /** Shown on screen. */
  name: string;
  /** One or two sentences for the model: what the project is, what work on it looks like. */
  description: string;
  /** Words, window titles, paths, product names that mark this project's work. */
  hints: string[];
};

export type AmbientProjectsFile = { version: 1; projects: AmbientProject[] };

/** Where a chunk lands when it belongs to no project. Fixed, so totals stay comparable across days. */
export const FALLBACK_BUCKETS = ["personal", "admin", "other"] as const;
export type FallbackBucket = (typeof FALLBACK_BUCKETS)[number];

/** The bucket a chunk gets when the model named nothing usable. */
export const OTHER_BUCKET: FallbackBucket = "other";

export function isFallbackBucket(value: string): value is FallbackBucket {
  return (FALLBACK_BUCKETS as readonly string[]).includes(value);
}

const KEY = /^[a-z0-9-]+$/;

/**
 * Parses and validates the file's JSON. Throws with a plain message on anything a person
 * would want told about — a bad key, a duplicate, a key that collides with a bucket —
 * because a silently dropped project would make its hours vanish into "other".
 */
export function parseProjectsFile(raw: string): AmbientProjectsFile {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("projects.json must be a JSON object.");
  const file = parsed as { version?: unknown; projects?: unknown };
  if (file.version !== 1) throw new Error('projects.json needs "version": 1.');
  if (!Array.isArray(file.projects)) throw new Error('projects.json needs a "projects" array.');

  const seen = new Set<string>();
  const projects = file.projects.map((entry, index): AmbientProject => {
    if (!entry || typeof entry !== "object") throw new Error(`projects[${index}] must be an object.`);
    const project = entry as Partial<Record<keyof AmbientProject, unknown>>;
    if (typeof project.key !== "string" || !KEY.test(project.key)) {
      throw new Error(`projects[${index}].key must match ${KEY}.`);
    }
    if (isFallbackBucket(project.key)) throw new Error(`"${project.key}" is a reserved bucket name.`);
    if (seen.has(project.key)) throw new Error(`Duplicate project key "${project.key}".`);
    seen.add(project.key);
    if (typeof project.name !== "string" || project.name.trim().length === 0) {
      throw new Error(`projects[${index}].name is required.`);
    }
    return {
      key: project.key,
      name: project.name.trim(),
      description: typeof project.description === "string" ? project.description.trim() : "",
      hints: Array.isArray(project.hints) ? project.hints.filter((h): h is string => typeof h === "string") : [],
    };
  });

  return { version: 1, projects };
}

export const EMPTY_PROJECTS: AmbientProjectsFile = { version: 1, projects: [] };

/**
 * A key for a new project, from its name: lowercase, runs of anything else collapsed to a
 * dash, and a numeric suffix if that collides with a bucket or a key already in use. Keys
 * are what caches and chunks refer to, so an existing project keeps its key when renamed.
 */
export function keyForName(name: string, taken: Iterable<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const used = new Set<string>([...FALLBACK_BUCKETS, ...taken]);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Display name for a project key or bucket, given the file. Falls back to the key itself. */
export function projectName(key: string, projects: AmbientProject[], bucketNames: Record<FallbackBucket, string>): string {
  if (isFallbackBucket(key)) return bucketNames[key];
  return projects.find((project) => project.key === key)?.name ?? key;
}
