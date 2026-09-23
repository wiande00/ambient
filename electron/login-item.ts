import { app } from "electron";

/**
 * The Windows login item: an entry under `HKCU\...\CurrentVersion\Run` pointing at this
 * executable. Only ever written from a packaged build — in development `process.execPath`
 * is `node_modules/electron/dist/electron.exe`, which must never be registered.
 */

export function setOpenAtLogin(enabled: boolean): void {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath });
}

export function loginItemState(): { openAtLogin: boolean; willLaunchAtLogin: boolean } {
  if (!app.isPackaged) return { openAtLogin: false, willLaunchAtLogin: false };
  const settings = app.getLoginItemSettings();
  return {
    openAtLogin: settings.openAtLogin,
    // False when Windows' Startup Apps switch has disabled the entry without removing it.
    willLaunchAtLogin: settings.executableWillLaunchAtLogin ?? settings.openAtLogin,
  };
}
