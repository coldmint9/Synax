import { contextBridge, ipcRenderer } from "electron";
import type { UpdaterAction, UpdaterState } from "./contract.js";
contextBridge.exposeInMainWorld("synaxUpdater", {
  state: (): Promise<UpdaterState> => ipcRenderer.invoke("updater:state"),
  action: (action: UpdaterAction): Promise<UpdaterState> =>
    ipcRenderer.invoke("updater:action", action),
  subscribe: (callback: (state: UpdaterState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: UpdaterState) =>
      callback(state);
    ipcRenderer.on("updater:state", listener);
    return () => ipcRenderer.removeListener("updater:state", listener);
  },
});
