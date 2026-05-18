"use strict";
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
    platform: process.platform,
    showOpenDialog: (options) => ipcRenderer.invoke('dialog:open', options),
    showSaveDialog: (options) => ipcRenderer.invoke('dialog:save', options),
    getAppVersion: () => ipcRenderer.invoke('app:version'),
    getApiPort: () => ipcRenderer.invoke('app:api-port'),
    onDeepLink: (callback) => {
        ipcRenderer.on('deep-link', (_event, url) => callback(url));
    },
    onMenuNavigate: (callback) => {
        ipcRenderer.on('menu:navigate', (_event, path) => callback(path));
    },
    onMenuAction: (callback) => {
        ipcRenderer.on('menu:action', (_event, action) => callback(action));
    },
    updateProjects: (projects) => {
        ipcRenderer.send('menu:update-projects', projects);
    },
});
