import { app } from "electron";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Every path the shell touches. Data stays under `~/.ambient/`, shared with the collector
 * (which builds the same path from `%USERPROFILE%`) and the Next server (`os.homedir()`).
 * Bundled files live under `resources/` when packaged and in the checkout in development.
 */

export function ambientDir(): string {
  return join(homedir(), ".ambient");
}

export function configPath(): string {
  return join(ambientDir(), "config.json");
}

export function stopFlagPath(): string {
  return join(ambientDir(), "STOP");
}

export function collectorPidPath(): string {
  return join(ambientDir(), "collector.pid");
}

export function logsDir(): string {
  return join(ambientDir(), "logs");
}

/** Where the running app records its dashboard server's URL, for the MCP server to find it. */
export function dashboardInfoPath(): string {
  return join(ambientDir(), "dashboard.json");
}

/** Present while an "Add to Claude Desktop" is waiting for Claude Desktop to load the entry. */
export function claudeDesktopPendingPath(): string {
  return join(ambientDir(), "claude-desktop-pending.json");
}

/** Where downloaded installers wait to be installed. `AMBIENT_UPDATE_DIR` overrides. */
export function updatesDir(): string {
  return process.env.AMBIENT_UPDATE_DIR || join(ambientDir(), "updates");
}

/**
 * The newest GitHub release's manifest; the installer sits beside it under the same path.
 * `AMBIENT_UPDATE_URL` points elsewhere, and `off` turns the check off.
 */
export function updateFeedUrl(): string | null {
  const override = process.env.AMBIENT_UPDATE_URL;
  if (override === "off") return null;
  return override || "https://github.com/wiande00/ambient/releases/latest/download/latest.json";
}

/** The folder the installed app runs from, which is also where the installer writes the next one. */
export function installDir(): string {
  return dirname(process.execPath);
}

function bundledRoot(): string {
  return app.isPackaged ? process.resourcesPath : app.getAppPath();
}

export function collectorScriptPath(): string {
  return join(bundledRoot(), "collector", "collect.ps1");
}

/** The standalone Next server. Not under `resources/app`, which Electron would load as the app itself. */
export function standaloneServerPath(): string {
  return app.isPackaged ? join(process.resourcesPath, "server", "server.js") : join(app.getAppPath(), ".next", "standalone", "server.js");
}

export function trayIconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, "tray.png") : join(app.getAppPath(), "resources", "tray.png");
}

export function windowIconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, "icon.png") : join(app.getAppPath(), "resources", "icon.png");
}

export function powershellPath(): string {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function cmdPath(): string {
  return process.env.ComSpec ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
}
