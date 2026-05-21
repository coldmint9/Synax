import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSidecar, stopSidecar, getSidecarPort } from './lib/node-sidecar.js';
import { loadWindowState, saveWindowState } from './lib/window-state.js';
import { buildAppMenu, updateProjectsMenu } from './menu.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function createWindow(): BrowserWindow {
  const state = loadWindowState();

  const win = new BrowserWindow({
    ...state,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.on('ready-to-show', () => win.show());

  win.on('close', () => {
    const bounds = win.getBounds();
    saveWindowState({ ...bounds, isMaximized: win.isMaximized() });
  });

  return win;
}

function registerIPC(): void {
  ipcMain.handle('dialog:open', (_e, options) => dialog.showOpenDialog(options));
  ipcMain.handle('dialog:save', (_e, options) => dialog.showSaveDialog(options));
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:api-port', () => getSidecarPort());
  ipcMain.on('menu:update-projects', (_e, projects) => {
    updateProjectsMenu(projects);
  });
}

async function bootstrap(): Promise<void> {
  registerIPC();
  buildAppMenu();

  const externalApi = process.env.ELECTRON_SKIP_SIDECAR === '1';

  if (!externalApi) {
    console.log('[electron] starting API sidecar...');
    const port = await startSidecar();
    console.log(`[electron] API ready on port ${port}`);
  } else {
    console.log('[electron] using external API server');
  }

  mainWindow = createWindow();

  if (isDev) {
    const webPort = process.env.WEB_PORT || '5173';
    mainWindow.loadURL(`http://localhost:${webPort}`);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'web', 'dist', 'index.html'));
  }
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  stopSidecar();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    bootstrap();
  }
});

app.on('before-quit', () => {
  stopSidecar();
});
