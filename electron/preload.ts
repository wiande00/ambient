import { contextBridge, ipcRenderer } from "electron";
import type { AmbientBridge, AmbientDesktopStatus } from "../src/types/ambient-bridge";

/**
 * The only surface the page gets. Everything goes through named IPC channels; the page
 * never sees Node or Electron. The shape is declared in `src/types/ambient-bridge.d.ts`.
 */
const bridge: AmbientBridge = {
  isDesktop: true,
  applySettings: () => ipcRenderer.invoke("ambient:apply-settings"),
  getStatus: () => ipcRenderer.invoke("ambient:status"),
  restartCollector: () => ipcRenderer.invoke("ambient:restart-collector"),
  checkForUpdates: () => ipcRenderer.invoke("ambient:check-updates"),
  getConnector: () => ipcRenderer.invoke("ambient:connector"),
  installClaudeDesktop: () => ipcRenderer.invoke("ambient:install-claude-desktop"),
  installUpdate: () => ipcRenderer.invoke("ambient:install-update"),
  setWindowColors: (colors) => ipcRenderer.invoke("ambient:window-colors", colors),
  onStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: AmbientDesktopStatus) => listener(status);
    ipcRenderer.on("ambient:status", handler);
    return () => ipcRenderer.off("ambient:status", handler);
  },
  onDataChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("ambient:data-changed", handler);
    return () => ipcRenderer.off("ambient:data-changed", handler);
  },
};

contextBridge.exposeInMainWorld("ambient", bridge);
