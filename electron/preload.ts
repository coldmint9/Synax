const { contextBridge, ipcRenderer } =
  require("electron") as typeof import("electron");

if (process.isMainFrame)
  contextBridge.exposeInMainWorld("electronAPI", {
    platform: process.platform,
    showContextMenu: (request: unknown) => ipcRenderer.invoke("context-menu:show", request),
    onContextMenuAction: (callback: (requestId: string, actionId: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, requestId: string, actionId: string) => callback(requestId, actionId);
      ipcRenderer.on("context-menu:action", listener);
      return () => ipcRenderer.removeListener("context-menu:action", listener);
    },
    onContextMenuClosed: (callback: (requestId: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, requestId: string) => callback(requestId);
      ipcRenderer.on("context-menu:closed", listener);
      return () => ipcRenderer.removeListener("context-menu:closed", listener);
    },
    revealWorkspaceFile: (workspacePath: string, relativePath: string) =>
      ipcRenderer.invoke("context-menu:reveal", { workspacePath, relativePath }),
    copyWorkspaceFile: (workspacePath: string, relativePath: string) =>
      ipcRenderer.invoke("context-menu:copy-file", { workspacePath, relativePath }),
    showDesktopNotification: (payload: {
      id: string;
      projectId: string;
      sessionId: string;
      kind: "completed" | "input" | "approval" | "failed";
      title: string;
      body: string;
    }) => ipcRenderer.invoke("notifications:show", payload),
    setDesktopNotificationsEnabled: (enabled: boolean) =>
      ipcRenderer.send("notifications:enabled", enabled),
    dismissDesktopNotification: (sessionId: string) =>
      ipcRenderer.send("notifications:dismiss", sessionId),
    onDesktopNotificationOpen: (
      callback: (target: {
        projectId: string;
        sessionId: string;
        kind: "completed" | "input" | "approval" | "failed";
      }) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        target: Parameters<typeof callback>[0],
      ) => callback(target);
      ipcRenderer.on("notifications:open-session", listener);
      // Register the callback before draining a click queued during renderer reload.
      ipcRenderer.send("notifications:renderer-ready", true);
      return () => {
        ipcRenderer.removeListener("notifications:open-session", listener);
        ipcRenderer.send("notifications:renderer-ready", false);
      };
    },
    setTerminalFocus: (focused: boolean) =>
      ipcRenderer.send("terminal:focus", focused),
    showOpenDialog: (options: Electron.OpenDialogOptions) =>
      ipcRenderer.invoke("dialog:open", options),
    showSaveDialog: (options: Electron.SaveDialogOptions) =>
      ipcRenderer.invoke("dialog:save", options),
    getAppVersion: () => ipcRenderer.invoke("app:version"),
    getUpdateNetworkSettings: () => ipcRenderer.invoke("updates:get-network"),
    getDesktopUpdateState: () => ipcRenderer.invoke("updates:state"),
    checkDesktopUpdate: () => ipcRenderer.invoke("updates:check"),
    installDesktopUpdate: () => ipcRenderer.invoke("updates:install"),
    onDesktopUpdateState: (
      callback: (state: import("./updater/contract.js").UpdaterState) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        state: import("./updater/contract.js").UpdaterState,
      ) => callback(state);
      ipcRenderer.on("updates:state", listener);
      return () => ipcRenderer.removeListener("updates:state", listener);
    },
    onDesktopUpdateShow: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on("updates:show", listener);
      return () => ipcRenderer.removeListener("updates:show", listener);
    },
    setUpdateNetworkSettings: (
      settings: import("./lib/update-network.js").UpdateNetworkSettings,
    ) => ipcRenderer.invoke("updates:set-network", settings),
    getAccessibilitySupportEnabled: () =>
      ipcRenderer.invoke("app:accessibility-support-enabled"),
    onAccessibilitySupportChanged: (callback: (enabled: boolean) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, enabled: boolean) =>
        callback(enabled);
      ipcRenderer.on("app:accessibility-support-changed", listener);
      return () =>
        ipcRenderer.removeListener(
          "app:accessibility-support-changed",
          listener,
        );
    },
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
