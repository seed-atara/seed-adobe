/**
 * The only channel between the status window and the main process.
 *
 * Narrow on purpose. The window renders local HTML and needs four verbs; it
 * has no business with Node, the filesystem, or arbitrary IPC.
 */
import { contextBridge, ipcRenderer } from "electron";

export interface SeedStatus {
  service: "stopped" | "starting" | "running" | "failed";
  detail: string;
  debugMode: "on" | "off" | "unsupported";
  panelTarget: string;
  workspace: string;
  workspaceIsDefault: boolean;
  effects: "unsupported" | "unavailable" | "installed" | "not-installed";
  panelInstalled: boolean;
  version: string;
  baseUrl: string;
  log: string[];
}

contextBridge.exposeInMainWorld("seed", {
  status: (): Promise<SeedStatus> => ipcRenderer.invoke("seed:status"),
  restart: (): Promise<SeedStatus> => ipcRenderer.invoke("seed:restart"),
  reinstallPanel: (): Promise<SeedStatus> => ipcRenderer.invoke("seed:reinstall-panel"),
  revealPanel: (): Promise<void> => ipcRenderer.invoke("seed:reveal-panel"),
  chooseWorkspace: (): Promise<SeedStatus> => ipcRenderer.invoke("seed:choose-workspace"),
  revealWorkspace: (): Promise<void> => ipcRenderer.invoke("seed:reveal-workspace"),
  installEffects: (): Promise<SeedStatus> => ipcRenderer.invoke("seed:install-effects"),
  quit: (): Promise<void> => ipcRenderer.invoke("seed:quit"),
  onStatus: (handler: (status: SeedStatus) => void): void => {
    ipcRenderer.on("seed:status", (_event, value: SeedStatus) => handler(value));
  },
});
