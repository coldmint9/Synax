import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  showOpenDialog: (options: Electron.OpenDialogOptions) =>
    ipcRenderer.invoke('dialog:open', options),
  showSaveDialog: (options: Electron.SaveDialogOptions) =>
    ipcRenderer.invoke('dialog:save', options),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  getApiPort: () => ipcRenderer.invoke('app:api-port'),
  onDeepLink: (callback: (url: string) => void) => {
    ipcRenderer.on('deep-link', (_event, url) => callback(url));
  },
  onMenuNavigate: (callback: (path: string) => void) => {
    ipcRenderer.on('menu:navigate', (_event, path) => callback(path));
  },
  onMenuAction: (callback: (action: string) => void) => {
    ipcRenderer.on('menu:action', (_event, action) => callback(action));
  },
  updateProjects: (projects: { id: string; name: string }[]) => {
    ipcRenderer.send('menu:update-projects', projects);
  },
});
