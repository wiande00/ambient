import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_BREAK_MINUTES } from "@/lib/ambient/chunks";
import { parseConfig, type AmbientConfig } from "@/lib/ambient/config";
import { DEFAULT_AFK_THRESHOLD_S } from "@/lib/ambient/idle";
import { ambientDir } from "./store";

/**
 * Reads and writes `~/.ambient/config.json`. Read on every request and memoised on the
 * file's mtime, the same way `days.ts` caches logs, so a save from the Settings screen is
 * live on the next fetch with no restart. Environment variables remain a fallback for a key
 * or threshold the file does not set, which is what keeps `npm run dev` with `.env.local`
 * working.
 *
 * "The file does not set it" is read as "the file holds the default", which is why every
 * threshold's default lives in one place beside the rule it governs and is imported here
 * rather than written out again.
 */

export function configPath(): string {
  return join(ambientDir(), "config.json");
}

export type ConfigSource = "config" | "env" | "default";

export type LoadedConfig = {
  /** Effective settings, with env fallbacks applied. */
  config: AmbientConfig;
  /** Exactly what the file holds (or the defaults if there is none), for merging a patch into. */
  stored: AmbientConfig;
  exists: boolean;
  apiKeySource: ConfigSource;
  afkSource: ConfigSource;
  breakSource: ConfigSource;
};

let cache: { mtimeMs: number; loaded: LoadedConfig } | null = null;

function envNumber(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function withFallbacks(stored: AmbientConfig, exists: boolean): LoadedConfig {
  const envKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  const envAfk = envNumber("AMBIENT_AFK_SECONDS");
  const envBreak = envNumber("AMBIENT_BREAK_MINUTES");
  const fileSetsAfk = exists && stored.afkSeconds !== DEFAULT_AFK_THRESHOLD_S;
  const fileSetsBreak = exists && stored.breakMinutes !== DEFAULT_BREAK_MINUTES;
  const apiKeySource: ConfigSource = stored.anthropicApiKey ? "config" : envKey ? "env" : "default";
  const afkSource: ConfigSource = fileSetsAfk ? "config" : envAfk !== null ? "env" : "default";
  const breakSource: ConfigSource = fileSetsBreak ? "config" : envBreak !== null ? "env" : "default";
  return {
    config: {
      ...stored,
      anthropicApiKey: stored.anthropicApiKey || envKey,
      afkSeconds: afkSource === "env" && envAfk !== null ? envAfk : stored.afkSeconds,
      breakMinutes: breakSource === "env" && envBreak !== null ? envBreak : stored.breakMinutes,
    },
    stored,
    exists,
    apiKeySource,
    afkSource,
    breakSource,
  };
}

export async function loadConfig(): Promise<LoadedConfig> {
  const path = configPath();
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    cache = null;
    return withFallbacks(parseConfig(null), false);
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache.loaded;

  let raw: string | null;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    raw = null;
  }
  const loaded = withFallbacks(parseConfig(raw), raw !== null);
  cache = { mtimeMs, loaded };
  return loaded;
}

/** Write-then-rename, so the desktop shell or a concurrent request never reads a half-written file. */
export async function saveConfig(config: AmbientConfig): Promise<void> {
  await mkdir(ambientDir(), { recursive: true });
  const target = configPath();
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(tmp, target);
  cache = null;
}
