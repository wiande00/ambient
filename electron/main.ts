import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AmbientDesktopStatus } from "../src/types/ambient-bridge";
import { Collector } from "./collector";
import { readConfig, writeConfig } from "./config";
import { ClaudeDesktopGuard, connectorInfo } from "./connector";
import { DataWatcher } from "./data-watcher";
import { DayCloser } from "./day-closer";
import { RotatingLog } from "./log";
import { loginItemState, setOpenAtLogin } from "./login-item";
import { NextServer } from "./next-server";
import { dashboardInfoPath, logsDir } from "./paths";
import { AppTray } from "./tray";
import { Updater } from "./updater";
import { createWindow, showWindow } from "./window";

/**
 * The desktop shell: one dashboard window over the bundled Next server, one supervised
 * collector, a tray icon, the Windows login item, an updater that fetches the
 * next installer from GitHub, a watcher on the data folder that tells the page to refetch, and a pass
 * that finishes labelling any past day nobody opened to the end. Quitting is deliberate about
 * order so the collector gets to write the block that was open; installing an update is that
 * same quit followed by the installer.
 *
 * Environment switches for development:
 *   AMBIENT_DEV_URL          load this instead of starting the bundled server (default http://127.0.0.1:3000)
 *   AMBIENT_SERVE_STANDALONE=1  start `.next/standalone/server.js` even when unpackaged
 *   AMBIENT_NO_COLLECTOR=1   do not run the collector
 *   AMBIENT_UPDATE_DIR       read releases from here instead of ~/.ambient/updates
 */

const APP_ID = "com.ronnefalk.ambient";
/** Switches that make a launch a message to the running instance, never an app of its own. */
const REQUEST_SWITCHES = ["--quit", "--install-update"];

let win: BrowserWindow | null = null;
let tray: AppTray | null = null;
let server: NextServer | null = null;
let collector: Collector | null = null;
let updater: Updater | null = null;
let dataWatcher: DataWatcher | null = null;
let dayCloser: DayCloser | null = null;
let claudeDesktop: ClaudeDesktopGuard | null = null;
let serverUrl = "";
let quitting = false;
let appLog: RotatingLog | null = null;

app.setAppUserModelId(APP_ID);

const request = REQUEST_SWITCHES.find((flag) => process.argv.includes(flag));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else if (request) {
  // The lock went to a launch that only carried a request, so no instance took it: Ambient
  // was not running, or it was already quitting. The second can follow from this very
  // request. With no collector or server child to wait for, the running instance finishes
  // quitCleanly inside the handshake, answers it as a process that is shutting down, and
  // Chromium then hands its freed lock to this launch. Either way there is nothing to do.
  new RotatingLog(join(logsDir(), "app.log")).write(`[shell] ${request}: Ambient is not running (or was already quitting); nothing to do`);
  app.quit();
} else {
  // A second launch focuses the running instance. `Ambient.exe --quit` asks it to quit
  // cleanly instead, which is the scriptable way to stop the collector with its flush, and
  // `Ambient.exe --install-update` installs whatever release is ready, exactly as the
  // banner's button does.
  app.on("second-instance", (_event, argv) => {
    if (argv.includes("--quit")) app.quit();
    else if (argv.includes("--install-update")) void installUpdate();
    else showWindow(win);
  });
  app.on("window-all-closed", () => {
    // The app lives in the tray; closing the window is not quitting.
  });
  app.on("activate", () => showWindow(win));
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    void quitCleanly();
  });
  app
    .whenReady()
    .then(main)
    .catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      appLog?.write(`[shell] fatal: ${message}`);
      quitting = true;
      // Stop what did start before the modal dialog blocks the event loop.
      await Promise.allSettled([collector?.stop(), server?.stop()]);
      dialog.showErrorBox("Ambient could not start", `${message}\n\nLogs: ${logsDir()}`);
      app.exit(1);
    });
}

async function main(): Promise<void> {
  mkdirSync(logsDir(), { recursive: true });
  appLog = new RotatingLog(join(logsDir(), "app.log"));
  appLog.write(`[shell] Ambient ${app.getVersion()} starting (${app.isPackaged ? "packaged" : "development"})`);

  const { config, exists } = readConfig();
  if (!exists) {
    // First run: persist the defaults so the Settings screen shows a real file.
    writeConfig({});
    appLog.write("[shell] first run: wrote config.json with defaults");
  }
  // The file is the source of truth for the login item, and it may predate the desktop app
  // (the dashboard writes it from a browser too), so the registry entry is reconciled on
  // every start rather than only on the first. Idempotent, and a switch flipped off in
  // Windows' own Startup Apps page stays off: that lives in a separate key.
  setOpenAtLogin(config.openAtLogin);

  const serveBundled = app.isPackaged || process.env.AMBIENT_SERVE_STANDALONE === "1";
  if (serveBundled) {
    server = new NextServer(appLog, (url) => {
      serverUrl = url;
      writeDashboardInfo();
      if (win) void win.loadURL(url);
      broadcast();
    });
    serverUrl = await server.start();
  } else {
    serverUrl = process.env.AMBIENT_DEV_URL ?? "http://127.0.0.1:3000";
  }
  appLog.write(`[shell] dashboard at ${serverUrl}`);
  writeDashboardInfo();

  collector = new Collector(new RotatingLog(join(logsDir(), "collector.log")), () => broadcast());
  if (process.env.AMBIENT_NO_COLLECTOR === "1") {
    appLog.write("[shell] collector disabled by AMBIENT_NO_COLLECTOR");
  } else {
    await collector.start(config.collector.excludeApps);
  }

  updater = new Updater(appLog, () => broadcast());
  updater.start();

  win = createWindow(serverUrl, () => quitting);
  // The page refetches on this poke whether or not it is visible: a renderer timer is
  // throttled or silent in a covered or hidden window, an IPC message is not.
  dataWatcher = new DataWatcher(appLog, () => {
    if (win && !win.isDestroyed()) win.webContents.send("ambient:data-changed");
  });
  dataWatcher.start();
  // A day is labelled when someone opens it, so a day nobody opened to the end has hours in
  // no project's total. This finishes them, once each, in the background.
  dayCloser = new DayCloser(appLog, () => serverUrl);
  dayCloser.start();
  // An "Add to Claude Desktop" from an earlier run may still be waiting for Claude Desktop
  // to restart; the guard keeps the entry in its config until then.
  claudeDesktop = new ClaudeDesktopGuard(appLog);
  claudeDesktop.resume();
  // Sign-out and shutdown. Windows asks first (`query-session-end`) and allows a few seconds
  // for the answer, so the collector is told to stop synchronously here and given that time
  // to write the block it has open. The session is not vetoed: a tracker is not worth a
  // "this app is preventing shutdown" screen.
  const onSessionEnd = (what: string) => {
    if (quitting) return;
    appLog?.write(`[shell] ${what}`);
    collector?.stopSyncBestEffort(2_500);
    quitting = true;
  };
  win.on("query-session-end", (event) => onSessionEnd(`session ending: ${event.reasons.join(", ")}`));
  win.on("session-end", () => onSessionEnd("session ended"));

  tray = new AppTray({
    getStatus: status,
    onOpen: () => showWindow(win),
    onStartCollector: () => void collector?.start(readConfig().config.collector.excludeApps),
    onStopCollector: () => void collector?.stop(),
    onToggleOpenAtLogin: (enabled) => {
      writeConfig({ openAtLogin: enabled });
      setOpenAtLogin(enabled);
      broadcast();
    },
    onCheckForUpdates: () => void updater?.check(),
    onInstallUpdate: () => void installUpdate(),
    onQuit: () => app.quit(),
  });

  ipcMain.handle("ambient:status", () => status());
  ipcMain.handle("ambient:apply-settings", async () => {
    const { config: next } = readConfig();
    setOpenAtLogin(next.openAtLogin);
    await collector?.applyExcludeApps(next.collector.excludeApps);
    broadcast();
    return status();
  });
  ipcMain.handle("ambient:restart-collector", async () => {
    await collector?.restart(readConfig().config.collector.excludeApps);
    return status();
  });
  ipcMain.handle("ambient:check-updates", async () => {
    await updater?.check();
    return status();
  });
  ipcMain.handle("ambient:install-update", async () => {
    await installUpdate();
    return status();
  });
  ipcMain.handle("ambient:connector", () => connectorInfo());
  ipcMain.handle("ambient:install-claude-desktop", () => {
    if (!claudeDesktop) throw new Error("Ambient is still starting.");
    return claudeDesktop.install();
  });
}

function status(): AmbientDesktopStatus {
  const login = loginItemState();
  const configured = readConfig().config.openAtLogin;
  return {
    version: app.getVersion(),
    serverUrl,
    // Unpackaged builds never register a login item; report what the file says instead.
    openAtLogin: app.isPackaged ? login.openAtLogin : configured,
    willLaunchAtLogin: app.isPackaged ? login.willLaunchAtLogin : configured,
    collector: process.env.AMBIENT_NO_COLLECTOR === "1" ? { state: "disabled" } : (collector?.current() ?? { state: "stopped" }),
    logsDir: logsDir(),
    update: updater?.current() ?? { state: "idle", current: app.getVersion(), channel: "" },
  };
}

/**
 * `~/.ambient/dashboard.json`: where the dashboard server is, for the MCP server and any
 * script that wants the app's API. Written whenever the server comes up, removed on quit,
 * so a stale file means the app is not running.
 */
function writeDashboardInfo(): void {
  try {
    const path = dashboardInfoPath();
    writeFileSync(`${path}.tmp`, `${JSON.stringify({ url: serverUrl, version: app.getVersion(), pid: process.pid, since: new Date().toISOString() }, null, 2)}\n`, "utf8");
    renameSync(`${path}.tmp`, path);
  } catch (error) {
    appLog?.write(`[shell] could not write dashboard.json: ${String(error)}`);
  }
}

function broadcast(): void {
  tray?.refresh();
  if (win && !win.isDestroyed()) win.webContents.send("ambient:status", status());
}

async function quitCleanly(): Promise<void> {
  if (quitting) return;
  quitting = true;
  appLog?.write("[shell] quitting");
  try {
    updater?.stop();
    dataWatcher?.stop();
    dayCloser?.stop();
    claudeDesktop?.stop();
    await Promise.allSettled([collector?.stop(), server?.stop()]);
  } finally {
    rmSync(dashboardInfoPath(), { force: true });
    tray?.destroy();
    appLog?.write("[shell] bye");
    app.exit(0);
  }
}

/**
 * The update path: the same clean quit, with the installer handed off first. The hand-off
 * only spawns a script that waits for this process to exit, so the order is safe: the
 * collector flushes before the installer touches anything.
 */
async function installUpdate(): Promise<void> {
  if (quitting || !updater) return;
  const state = updater.current();
  if (state.state !== "ready") {
    appLog?.write(`[update] install requested but state is ${state.state}`);
    return;
  }
  appLog?.write(`[update] installing ${state.version}`);
  if (!updater.launchInstaller()) return;
  broadcast();
  await quitCleanly();
}
