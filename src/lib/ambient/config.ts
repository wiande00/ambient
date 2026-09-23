import { DEFAULT_BREAK_MINUTES } from "./chunks";
import { DEFAULT_AFK_THRESHOLD_S } from "./idle";

/**
 * The app's own settings, as stored in `~/.ambient/config.json`. Pure: parsing, validation
 * and masking only, so the same rules serve the settings route and the desktop shell.
 *
 * The file is written by the Settings screen and read per request by the routes, which is
 * what lets a change apply without restarting anything. A missing or damaged file is the
 * defaults, never an error — the dashboard must paint on a machine that has never saved.
 */

export const CONFIG_VERSION = 1;
export const AFK_MIN_S = 30;
export const AFK_MAX_S = 3600;
export const BREAK_MIN_M = 5;
export const BREAK_MAX_M = 240;
export const DEFAULT_EXCLUDE_APPS = ["1password", "bitwarden", "keepass"];

export type AmbientConfig = {
  version: typeof CONFIG_VERSION;
  /** Empty when none is set. */
  anthropicApiKey: string;
  /** The idle rule's threshold, in seconds. */
  afkSeconds: number;
  /** How long an idle run has to be to count as a break and end a chunk, in minutes. */
  breakMinutes: number;
  /** Whether the desktop app registers itself to start at Windows sign-in. */
  openAtLogin: boolean;
  collector: {
    /** Process names that never get content extraction. Lowercase. */
    excludeApps: string[];
  };
};

export const DEFAULT_CONFIG: AmbientConfig = {
  version: CONFIG_VERSION,
  anthropicApiKey: "",
  afkSeconds: DEFAULT_AFK_THRESHOLD_S,
  breakMinutes: DEFAULT_BREAK_MINUTES,
  openAtLogin: true,
  collector: { excludeApps: DEFAULT_EXCLUDE_APPS },
};

/** A partial update as the settings route accepts it. An empty key clears it; an omitted one keeps it. */
export type AmbientConfigPatch = Partial<{
  anthropicApiKey: string;
  afkSeconds: number;
  breakMinutes: number;
  openAtLogin: boolean;
  excludeApps: string[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAfkSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= AFK_MIN_S && value <= AFK_MAX_S;
}

function isBreakMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= BREAK_MIN_M && value <= BREAK_MAX_M;
}

/** Trim, lowercase, drop empties and duplicates. Accepts an array or a comma-separated string. */
export function normaliseApps(value: unknown): string[] | null {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (parts === null) return null;
  const out: string[] = [];
  for (const part of parts) {
    if (typeof part !== "string") return null;
    const app = part.trim().toLowerCase();
    if (app && !out.includes(app)) out.push(app);
  }
  return out;
}

/** Tolerant: every field that is missing or malformed takes its default. Never throws. */
export function parseConfig(raw: string | null): AmbientConfig {
  if (raw === null) return DEFAULT_CONFIG;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_CONFIG;
  }
  if (!isRecord(parsed)) return DEFAULT_CONFIG;
  const collector = isRecord(parsed.collector) ? parsed.collector : {};
  return {
    version: CONFIG_VERSION,
    anthropicApiKey: typeof parsed.anthropicApiKey === "string" ? parsed.anthropicApiKey.trim() : "",
    afkSeconds: isAfkSeconds(parsed.afkSeconds) ? parsed.afkSeconds : DEFAULT_AFK_THRESHOLD_S,
    breakMinutes: isBreakMinutes(parsed.breakMinutes) ? parsed.breakMinutes : DEFAULT_BREAK_MINUTES,
    openAtLogin: typeof parsed.openAtLogin === "boolean" ? parsed.openAtLogin : DEFAULT_CONFIG.openAtLogin,
    collector: { excludeApps: normaliseApps(collector.excludeApps) ?? DEFAULT_EXCLUDE_APPS },
  };
}

export type PatchResult = { ok: true; patch: AmbientConfigPatch } | { ok: false; errors: string[] };

/** Checks a request body field by field. Unknown fields are ignored; a wrong one is named. */
export function validatePatch(body: unknown): PatchResult {
  if (!isRecord(body)) return { ok: false, errors: ["The body must be a JSON object."] };
  const errors: string[] = [];
  const patch: AmbientConfigPatch = {};

  if ("anthropicApiKey" in body) {
    if (typeof body.anthropicApiKey !== "string") errors.push("anthropicApiKey must be a string.");
    else patch.anthropicApiKey = body.anthropicApiKey.trim();
  }
  if ("afkSeconds" in body) {
    if (!isAfkSeconds(body.afkSeconds)) errors.push(`afkSeconds must be a whole number between ${AFK_MIN_S} and ${AFK_MAX_S}.`);
    else patch.afkSeconds = body.afkSeconds;
  }
  if ("breakMinutes" in body) {
    if (!isBreakMinutes(body.breakMinutes)) errors.push(`breakMinutes must be a whole number between ${BREAK_MIN_M} and ${BREAK_MAX_M}.`);
    else patch.breakMinutes = body.breakMinutes;
  }
  if ("openAtLogin" in body) {
    if (typeof body.openAtLogin !== "boolean") errors.push("openAtLogin must be true or false.");
    else patch.openAtLogin = body.openAtLogin;
  }
  if ("excludeApps" in body) {
    const apps = normaliseApps(body.excludeApps);
    if (apps === null) errors.push("excludeApps must be a list of app names.");
    else patch.excludeApps = apps;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, patch };
}

export function applyPatch(config: AmbientConfig, patch: AmbientConfigPatch): AmbientConfig {
  return {
    version: CONFIG_VERSION,
    anthropicApiKey: patch.anthropicApiKey ?? config.anthropicApiKey,
    afkSeconds: patch.afkSeconds ?? config.afkSeconds,
    breakMinutes: patch.breakMinutes ?? config.breakMinutes,
    openAtLogin: patch.openAtLogin ?? config.openAtLogin,
    collector: { excludeApps: patch.excludeApps ?? config.collector.excludeApps },
  };
}

/** Enough of a key to recognise it, never enough to use it. */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) return "*".repeat(key.length);
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}
