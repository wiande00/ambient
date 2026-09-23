import { app } from "electron";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AmbientConnectorInfo } from "../src/types/ambient-bridge";
import type { RotatingLog } from "./log";
import { claudeDesktopPendingPath } from "./paths";

/**
 * The MCP connector: how Claude reaches Ambient. The server itself is `mcp/server.ts`,
 * shipped as `resources/mcp/server.cjs` and run by this very executable in Node mode, so
 * nothing else needs installing. This module knows the command line for it and can write
 * that into Claude Desktop's config; for Claude Code it hands back the `claude mcp add`
 * line, since that lives in the user's own config and is one command to run.
 */

const SERVER_NAME = "ambient";
/** Lets a write-then-rename by Claude Desktop land before the file is read. */
const DEBOUNCE_MS = 500;

export type ConnectorCommand = { command: string; args: string[]; env: Record<string, string> };

export function connectorCommand(): ConnectorCommand {
  if (app.isPackaged) {
    return {
      command: process.execPath,
      args: [join(process.resourcesPath, "mcp", "server.cjs")],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  return { command: "node", args: [join(app.getAppPath(), "dist-electron", "mcp.cjs")], env: {} };
}

/** Package family names Claude Desktop ships under on Windows, as its own code lists them. */
const CLAUDE_PACKAGES = ["Claude_pzs8sxrjxfjjc", "AnthropicPBC.Claude_fnn82j28hfe8t"];
const CONFIG_NAME = "claude_desktop_config.json";

/**
 * Claude Desktop installed as an MSIX package keeps its files in the package's LocalCache and
 * only shows them at `%APPDATA%\Claude` to processes inside the package. Ambient runs outside
 * it, so a write to `%APPDATA%\Claude` would land in a folder Claude never reads. The package
 * folder wins when it exists; the plain path is for a classic install.
 */
export function claudeDesktopConfigPath(): string {
  const localAppData = process.env.LOCALAPPDATA ?? join(app.getPath("home"), "AppData", "Local");
  for (const family of CLAUDE_PACKAGES) {
    const dir = join(localAppData, "Packages", family, "LocalCache", "Roaming", "Claude");
    if (existsSync(dir)) return join(dir, CONFIG_NAME);
  }
  const appData = process.env.APPDATA ?? join(app.getPath("home"), "AppData", "Roaming");
  return join(appData, "Claude", CONFIG_NAME);
}

/** Quote for a shell so the line can be pasted into PowerShell or bash as is. */
function shellQuote(value: string): string {
  return /^[\w./:\\-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

export function claudeCodeCommand(): string {
  const { command, args, env } = connectorCommand();
  // `-e` takes several values, so it goes after the name or it swallows it.
  const envFlags = Object.entries(env).map(([k, v]) => `-e ${k}=${v}`);
  return ["claude mcp add --scope user", SERVER_NAME, ...envFlags, "--", shellQuote(command), ...args.map(shellQuote)].join(" ");
}

type DesktopConfig = { mcpServers?: Record<string, unknown> } & Record<string, unknown>;

function parseDesktopConfig(raw: string): DesktopConfig {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${claudeDesktopConfigPath()} is not a JSON object.`);
  return parsed as DesktopConfig;
}

function readDesktopConfig(): { config: DesktopConfig; exists: boolean } {
  const path = claudeDesktopConfigPath();
  if (!existsSync(path)) return { config: {}, exists: false };
  return { config: parseDesktopConfig(readFileSync(path, "utf8")), exists: true };
}

function sameCommand(entry: unknown, wanted: ConnectorCommand): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as { command?: unknown; args?: unknown };
  return e.command === wanted.command && Array.isArray(e.args) && e.args.join("\0") === wanted.args.join("\0");
}

/** Put the entry in, keeping everything else in the file exactly as it is. Returns the text written. */
function writeEntry(config: DesktopConfig): string {
  const path = claudeDesktopConfigPath();
  const servers = config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};
  const text = `${JSON.stringify({ ...config, mcpServers: { ...servers, [SERVER_NAME]: connectorCommand() } }, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
  return text;
}

function isWaiting(): boolean {
  return existsSync(claudeDesktopPendingPath());
}

function setWaiting(waiting: boolean): void {
  const path = claudeDesktopPendingPath();
  if (!waiting) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ since: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

export function connectorInfo(): AmbientConnectorInfo {
  const wanted = connectorCommand();
  let claudeDesktop: AmbientConnectorInfo["claudeDesktop"];
  try {
    const { config, exists } = readDesktopConfig();
    const entry = config.mcpServers?.[SERVER_NAME];
    claudeDesktop = !exists ? "not-installed" : !entry ? "absent" : !sameCommand(entry, wanted) ? "outdated" : isWaiting() ? "waiting" : "current";
  } catch {
    claudeDesktop = "unreadable";
  }
  return {
    ...wanted,
    claudeDesktop,
    claudeDesktopConfigPath: claudeDesktopConfigPath(),
    claudeCodeCommand: claudeCodeCommand(),
  };
}

/**
 * Keeps the `ambient` entry in Claude Desktop's config until Claude Desktop has loaded it.
 *
 * Claude Desktop reads that file once, when it starts, and from then on writes the whole of
 * it from the copy it read: whenever one of its settings changes, and again as it quits. An
 * entry added while it runs is gone at its next write, restart included, which is how a
 * plain "Add to Claude Desktop" used to come to nothing. So after an install the shell
 * watches the file: a write that drops the entry gets it put back, and a write that is not
 * ours and keeps it means the writer had loaded it, so the guard stands down. The wait is
 * recorded under `~/.ambient/`, so it resumes if Ambient restarts before Claude Desktop does.
 */
export class ClaudeDesktopGuard {
  private watcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  /** The file as the guard last read or wrote it; anything else is someone else's write. */
  private lastSeen: string | null = null;

  constructor(private readonly log: RotatingLog) {}

  /** Pick up a wait an earlier run left open. */
  resume(): void {
    if (isWaiting()) this.start();
  }

  /** Add or refresh the entry, keeping a backup of the file, and hold it until Claude Desktop loads it. */
  install(): AmbientConnectorInfo {
    const path = claudeDesktopConfigPath();
    const { config, exists } = readDesktopConfig();
    if (exists) copyFileSync(path, `${path}.ambient-backup`);
    this.lastSeen = writeEntry(config);
    setWaiting(true);
    this.log.write(`[connector] added to ${path}; holding it until Claude Desktop loads it`);
    this.start();
    return connectorInfo();
  }

  stop(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
    this.debounce = null;
    this.watcher = null;
  }

  private start(): void {
    if (this.watcher) return;
    const path = claudeDesktopConfigPath();
    const name = basename(path);
    try {
      // The folder, not the file: a write-then-rename replaces the file a file watch is on.
      this.watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
        if (filename && String(filename) !== name) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          this.debounce = null;
          this.check();
        }, DEBOUNCE_MS);
      });
      this.watcher.on("error", (error) => this.log.write(`[connector] watcher stopped: ${String(error)}`));
    } catch (error) {
      this.log.write(`[connector] cannot watch ${dirname(path)}: ${String(error)}`);
      return;
    }
    this.check();
  }

  private check(): void {
    let raw: string;
    let config: DesktopConfig;
    try {
      raw = readFileSync(claudeDesktopConfigPath(), "utf8");
      if (raw === this.lastSeen) return;
      config = parseDesktopConfig(raw);
    } catch {
      // Missing for a moment, or half written: never write over a file that did not parse.
      return;
    }
    const firstLook = this.lastSeen === null;
    if (sameCommand(config.mcpServers?.[SERVER_NAME], connectorCommand())) {
      this.lastSeen = raw;
      // Resuming, the entry being there says only that nothing has written since.
      if (firstLook) return;
      this.log.write("[connector] Claude Desktop wrote its config with the entry in: it has loaded it");
      setWaiting(false);
      this.stop();
      return;
    }
    try {
      this.lastSeen = writeEntry(config);
      this.log.write("[connector] Claude Desktop rewrote its config without the entry; put it back");
    } catch (error) {
      this.log.write(`[connector] could not put the entry back: ${String(error)}`);
    }
  }
}
