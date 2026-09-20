const { contextBridge, ipcRenderer } =
  require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  appearance: {
    get: () => ipcRenderer.invoke("appearance:get"),
    update: (
      patch: import("./appearance-contract.js").DesktopAppearancePatch,
    ) => ipcRenderer.invoke("appearance:update", patch),
    previewOpacity: (opacity: number) =>
      ipcRenderer.send("appearance:preview-opacity", opacity),
    chooseBackground: () => ipcRenderer.invoke("appearance:choose-background"),
    removeBackground: () => ipcRenderer.invoke("appearance:remove-background"),
  },
  setTerminalFocus: (focused: boolean) =>
    ipcRenderer.send("terminal:focus", focused),
  showOpenDialog: (options: Electron.OpenDialogOptions) =>
    ipcRenderer.invoke("dialog:open", options),
  showSaveDialog: (options: Electron.SaveDialogOptions) =>
    ipcRenderer.invoke("dialog:save", options),
  getAppVersion: () => ipcRenderer.invoke("app:version"),
  reportUIReady: () => ipcRenderer.send("app:ui-ready"),
  getApiPort: () => ipcRenderer.invoke("app:api-port"),
  getRuntimeToken: () => ipcRenderer.invoke("app:runtime-token"),
  onDeepLink: (callback: (url: string) => void) => {
    ipcRenderer.on("deep-link", (_event, url) => callback(url));
  },
  onMenuNavigate: (callback: (path: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, path: string) =>
      callback(path);
    ipcRenderer.on("menu:navigate", listener);
    return () => ipcRenderer.removeListener("menu:navigate", listener);
  },
  onMenuAction: (callback: (action: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: string) =>
      callback(action);
    ipcRenderer.on("menu:action", listener);
    return () => ipcRenderer.removeListener("menu:action", listener);
  },
  updateMenuState: (state: {
    projectId: string | null;
    hasSession: boolean;
    hasViewer: boolean;
    inWork: boolean;
    inWiki: boolean;
    dark: boolean;
  }) => ipcRenderer.send("menu:update-state", state),
  updateProjects: (projects: { id: string; name: string }[]) => {
    ipcRenderer.send("menu:update-projects", projects);
  },
});
