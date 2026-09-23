import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { applyPatch, parseConfig, type AmbientConfig, type AmbientConfigPatch } from "../src/lib/ambient/config";
import { ambientDir, configPath } from "./paths";

/**
 * The shell's view of `~/.ambient/config.json`, sharing the parser with the Next side so
 * both read the file the same way. The Settings screen writes through the settings route;
 * the shell writes only for the tray's "Start at login" toggle, and reads whenever it is
 * asked to apply a change.
 */

export function readConfig(): { config: AmbientConfig; exists: boolean } {
  let raw: string | null;
  try {
    raw = readFileSync(configPath(), "utf8");
  } catch {
    raw = null;
  }
  return { config: parseConfig(raw), exists: raw !== null };
}

/** Read-modify-write through a temp file, the same way every other writer under `~/.ambient` works. */
export function writeConfig(patch: AmbientConfigPatch): AmbientConfig {
  const next = applyPatch(readConfig().config, patch);
  mkdirSync(ambientDir(), { recursive: true });
  const target = configPath();
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmp, target);
  return next;
}
