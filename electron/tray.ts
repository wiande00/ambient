import { Menu, Tray, nativeImage } from "electron";
import type { AmbientDesktopStatus } from "../src/types/ambient-bridge";
import { trayIconPath } from "./paths";

/**
 * The tray icon and its menu. The menu is rebuilt whenever status changes, since Electron
 * menus are immutable once built.
 */

export type TrayHandlers = {
  getStatus: () => AmbientDesktopStatus;
  onOpen: () => void;
  onStartCollector: () => void;
  onStopCollector: () => void;
  onToggleOpenAtLogin: (enabled: boolean) => void;
  onCheckForUpdates: () => void;
  onInstallUpdate: () => void;
  onQuit: () => void;
};

export class AppTray {
  private readonly tray: Tray;

  constructor(private readonly handlers: TrayHandlers) {
    const image = nativeImage.createFromPath(trayIconPath());
    this.tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    this.tray.setToolTip("Ambient");
    this.tray.on("click", handlers.onOpen);
    this.tray.on("double-click", handlers.onOpen);
    this.refresh();
  }

  refresh(): void {
    const status = this.handlers.getStatus();
    const c = status.collector;
    const collectorLine =
      c.state === "running"
        ? `Collector: running (pid ${c.pid})`
        : c.state === "restarting"
          ? `Collector: restarting in ${c.inSeconds} s`
          : c.state === "disabled"
            ? "Collector: not managed"
            : "Collector: stopped";
    const running = c.state === "running" || c.state === "restarting";

    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Ambient", click: this.handlers.onOpen },
        { type: "separator" },
        { label: collectorLine, enabled: false },
        c.state === "disabled"
          ? { label: "Start collector", enabled: false }
          : running
            ? { label: "Stop collector", click: this.handlers.onStopCollector }
            : { label: "Start collector", click: this.handlers.onStartCollector },
        {
          label: "Start at login",
          type: "checkbox",
          checked: status.openAtLogin,
          click: (item) => this.handlers.onToggleOpenAtLogin(item.checked),
        },
        { type: "separator" },
        this.updateItem(status),
        { label: `Ambient ${status.version}`, enabled: false },
        { type: "separator" },
        { label: "Quit Ambient", click: this.handlers.onQuit },
      ]),
    );
    this.tray.setToolTip(`Ambient — ${collectorLine.replace("Collector: ", "collector ")}`);
  }

  destroy(): void {
    this.tray.destroy();
  }

  private updateItem(status: AmbientDesktopStatus): Electron.MenuItemConstructorOptions {
    const u = status.update;
    switch (u.state) {
      case "ready":
        return { label: `Update to Ambient ${u.version}…`, click: this.handlers.onInstallUpdate };
      case "installing":
        return { label: `Installing Ambient ${u.version}…`, enabled: false };
      case "checking":
        return { label: "Checking for updates…", enabled: false };
      default:
        return { label: "Check for updates", click: this.handlers.onCheckForUpdates };
    }
  }
}
