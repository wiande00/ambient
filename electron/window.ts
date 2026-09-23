import { BrowserWindow, shell } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AmbientWindowColors } from "../src/types/ambient-bridge";
import { windowIconPath } from "./paths";

/**
 * The caption buttons Windows draws over the page's title bar. One pixel short of the bar's
 * 48, so the rule along its bottom edge runs under the buttons too instead of stopping at them.
 */
const TITLE_BAR_HEIGHT = 47;

/**
 * The desk theme's light values, held until the page reports the mode it is in. Dark mode
 * reports before the window is shown, so these are only ever seen in light.
 */
const LIGHT: AmbientWindowColors = { titleBar: "#FAF4E9", symbols: "#4A4034", background: "#FFFCF6" };

/** How long a painted page may take to report its colours before the window opens without them. */
const REVEAL_FALLBACK_MS = 1_500;

/**
 * The one dashboard window. Closing hides it — the app lives in the tray — and quitting is
 * the tray's job. Loaded over loopback HTTP from the bundled Next server, never `file://`.
 *
 * The window has no title bar of its own: the page's title bar stands in for it, and
 * Windows draws the real minimise, maximise and close buttons over that bar's right end.
 * A Windows title bar above the app's own would look like one window inside another.
 */
export function createWindow(url: string, isQuitting: () => boolean): BrowserWindow {
  const icon = windowIconPath();
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: LIGHT.titleBar, symbolColor: LIGHT.symbols, height: TITLE_BAR_HEIGHT },
    backgroundColor: LIGHT.background,
    ...(existsSync(icon) ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Chromium slows a covered or minimised window's timers to a crawl and reports it as
      // hidden, which left the day's totals frozen until the window was clicked. The page
      // keeps its slow refetch running instead, so it is current the moment it is shown.
      backgroundThrottling: false,
    },
  });

  // Opened once the page has told the window its colours, so a dark page never opens under
  // light caption buttons. A page that never reports, such as an error page, opens anyway
  // shortly after it paints. Any earlier show — the tray, a second launch — settles it too.
  let shown = false;
  win.once("show", () => {
    shown = true;
  });
  const reveal = () => {
    if (!shown && !win.isDestroyed()) win.show();
  };
  win.once("ready-to-show", () => setTimeout(reveal, REVEAL_FALLBACK_MS));
  // Scoped to this window's page rather than registered on `ipcMain`: it is the window's
  // own business, and it goes when the window does.
  win.webContents.ipc.handle("ambient:window-colors", (_event, colors: unknown) => {
    if (isWindowColors(colors)) {
      win.setTitleBarOverlay({ color: colors.titleBar, symbolColor: colors.symbols, height: TITLE_BAR_HEIGHT });
      win.setBackgroundColor(colors.background);
    }
    reveal();
  });

  win.on("close", (event) => {
    if (isQuitting()) return;
    event.preventDefault();
    win.hide();
  });
  // Anything that is not the dashboard opens in the default browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      void shell.openExternal(target);
    }
  });

  void win.loadURL(url);
  return win;
}

export function showWindow(win: BrowserWindow | null): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function isWindowColors(value: unknown): value is AmbientWindowColors {
  if (typeof value !== "object" || value === null) return false;
  const { titleBar, symbols, background } = value as Record<string, unknown>;
  return [titleBar, symbols, background].every((color) => typeof color === "string" && HEX.test(color));
}
