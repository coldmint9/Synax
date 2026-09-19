"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("electronAPI", {
    platform: process.platform,
    showOpenDialog: (options) => ipcRenderer.invoke("dialog:open", options),
    showSaveDialog: (options) => ipcRenderer.invoke("dialog:save", options),
    getAppVersion: () => ipcRenderer.invoke("app:version"),
    getApiPort: () => ipcRenderer.invoke("app:api-port"),
    getRuntimeToken: () => ipcRenderer.invoke("app:runtime-token"),
    onDeepLink: (callback) => {
        ipcRenderer.on("deep-link", (_event, url) => callback(url));
    },
    onMenuNavigate: (callback) => {
        const listener = (_event, path) => callback(path);
        ipcRenderer.on("menu:navigate", listener);
        return () => ipcRenderer.removeListener("menu:navigate", listener);
    },
    onMenuAction: (callback) => {
        const listener = (_event, action) => callback(action);
        ipcRenderer.on("menu:action", listener);
        return () => ipcRenderer.removeListener("menu:action", listener);
    },
    updateProjects: (projects) => {
        ipcRenderer.send("menu:update-projects", projects);
    },
});
