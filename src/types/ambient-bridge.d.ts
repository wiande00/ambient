/**
 * What the desktop shell exposes to the page through its preload script. Absent in a plain
 * browser, so every use is `window.ambient?.…` and the screens degrade to web behaviour.
 */

export type AmbientCollectorStatus =
  | { state: "running"; pid: number; since: string }
  | { state: "stopped" }
  | { state: "restarting"; inSeconds: number; attempt: number }
  | { state: "disabled" };

/**
 * Where the shell stands with updates. `ready` means a newer installer sits in the update
 * channel, its hash has been checked, and installing is one click away. `installing` is the
 * last thing the page sees before the app restarts.
 */
export type AmbientUpdateState = {
  /** The running version. */
  current: string;
  /** The folder downloaded installers wait in. */
  channel: string;
  /** When the channel was last read, ISO. Absent before the first check. */
  checkedAt?: string;
} & (
  | { state: "idle" }
  | { state: "checking" }
  | { state: "up-to-date" }
  | { state: "ready"; version: string; publishedAt?: string; notes?: string }
  | { state: "installing"; version: string }
  | { state: "error"; message: string }
);

export type AmbientDesktopStatus = {
  version: string;
  serverUrl: string;
  openAtLogin: boolean;
  /** False when Windows' own Startup Apps switch has turned the entry off. */
  willLaunchAtLogin: boolean;
  collector: AmbientCollectorStatus;
  logsDir: string;
  update: AmbientUpdateState;
};

/** How Claude reaches Ambient: the MCP server's command line and whether Claude Desktop has it. */
export type AmbientConnectorInfo = {
  command: string;
  args: string[];
  env: Record<string, string>;
  /**
   * not-installed: no Claude Desktop config file. absent: file exists, no ambient entry.
   * waiting: entry added, held in place until Claude Desktop restarts and loads it.
   * current: entry matches this build. outdated: entry points elsewhere. unreadable: the file is not JSON.
   */
  claudeDesktop: "not-installed" | "absent" | "waiting" | "current" | "outdated" | "unreadable";
  claudeDesktopConfigPath: string;
  /** The one line that registers the server with Claude Code. */
  claudeCodeCommand: string;
};

/**
 * The colours the window's own chrome takes from the page. The page's title bar is the
 * window's, and Windows draws the caption buttons over its right end, so they have to be
 * told which mode the page is in. Hex, as the theme tokens declare them.
 */
export type AmbientWindowColors = {
  /** Behind the caption buttons: the page's title bar. */
  titleBar: string;
  /** The caption buttons' glyphs. */
  symbols: string;
  /** What the window paints where the page has yet to, such as a strip opened by a resize. */
  background: string;
};

export type AmbientBridge = {
  /** The MCP connector's command line and install state. */
  getConnector(): Promise<AmbientConnectorInfo>;
  /** Write the connector into Claude Desktop's config (a backup is kept). Claude Desktop needs a restart afterwards. */
  installClaudeDesktop(): Promise<AmbientConnectorInfo>;
  isDesktop: true;
  /** Re-read config.json and apply what only the shell can: the login item, the collector's arguments. */
  applySettings(): Promise<AmbientDesktopStatus>;
  getStatus(): Promise<AmbientDesktopStatus>;
  restartCollector(): Promise<AmbientDesktopStatus>;
  /** Read the update channel now rather than on the next timer tick. */
  checkForUpdates(): Promise<AmbientDesktopStatus>;
  /** Quit cleanly, run the installer that is ready, and start the new build. Resolves only if nothing is ready. */
  installUpdate(): Promise<AmbientDesktopStatus>;
  /** Match the window's chrome to the page. The first call also shows a window that is waiting to open. */
  setWindowColors(colors: AmbientWindowColors): Promise<void>;
  onStatus(listener: (status: AmbientDesktopStatus) => void): () => void;
  /**
   * Fires when something under `~/.ambient/` that the screens read has changed — a block
   * written by the collector, the off-computer switch, the projects file — so the page can
   * refetch at once instead of waiting for its timer. Delivered to a hidden window too.
   */
  onDataChanged(listener: () => void): () => void;
};

declare global {
  interface Window {
    ambient?: AmbientBridge;
  }
}
