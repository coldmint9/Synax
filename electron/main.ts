import { isTerminalSystemShortcut } from "./lib/terminal-shortcuts.js";
import fs from "node:fs/promises";
import { app, BrowserWindow, ipcMain, dialog, protocol, net } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  startSidecar,
  stopSidecar,
  getSidecarPort,
} from "./lib/node-sidecar.js";
import { getDataRoot, getResourcePath } from "./lib/data-paths.js";
import { loadWindowState, saveWindowState } from "./lib/window-state.js";
import {
  buildAppMenu,
  setUiUpdateAction,
  updateMenuState,
  updateProjectsMenu,
} from "./menu.js";
import { handleSquirrelEvent } from "./lib/squirrel-startup.js";
import { UiUpdates } from "./lib/ui-updates.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let terminalFocused = false;
let uiUpdates: UiUpdates | null = null;
let uiReadyTimer: NodeJS.Timeout | null = null;

// Register custom protocol scheme before app is ready
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

if (process.platform === "win32")
  app.setAppUserModelId("com.squirrel.Synax.Synax");
const installerEvent = handleSquirrelEvent();
const gotLock = !installerEvent && app.requestSingleInstanceLock();
if (!installerEvent && !gotLock) {
  app.quit();
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function createWindow(): BrowserWindow {
  terminalFocused = false;
  const state = loadWindowState();

  const win = new BrowserWindow({
    ...state,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 14, y: 18 } }
      : {}),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on("before-input-event", (_event, input) => {
    win.webContents.setIgnoreMenuShortcuts(
      terminalFocused && !isTerminalSystemShortcut(input),
    );
  });
  const showWindow = () => {
    if (!win.isDestroyed() && !win.isVisible()) {
      win.show();
    }
  };

  win.on("ready-to-show", showWindow);
  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL) => {
      console.error("[electron] renderer failed to load", {
        errorCode,
        errorDescription,
        validatedURL,
      });
      showWindow();
      void recoverUi(win);
    },
  );
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error("[electron] renderer process gone", details);
    showWindow();
    void recoverUi(win);
  });

  const fallbackTimer = setTimeout(showWindow, 5000);
  fallbackTimer.unref?.();

  win.on("close", () => {
    const bounds = win.getNormalBounds();
    saveWindowState({ ...bounds, isMaximized: win.isMaximized() });
  });

  if (state.isMaximized) win.maximize();
  return win;
}

let recoveringUi = false;
async function recoverUi(win: BrowserWindow): Promise<void> {
  if (recoveringUi || !uiUpdates || !mainWindow || win.isDestroyed()) return;
  recoveringUi = true;
  try {
    if (await uiUpdates.rollback()) {
      if (uiReadyTimer) clearTimeout(uiReadyTimer);
      console.warn(
        "[ui-update] reverting failed interface to the last known good version",
      );
      await win.loadURL("app://./index.html");
    }
  } catch (error) {
    console.error("[ui-update] rollback failed", error);
  } finally {
    recoveringUi = false;
  }
}

let protocolRegistered = false;
let ipcRegistered = false;
function registerIPC(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle("dialog:open", (_e, options) =>
    dialog.showOpenDialog(options),
  );
  ipcMain.handle("dialog:save", (_e, options) =>
    dialog.showSaveDialog(options),
  );
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.on("app:ui-ready", (event) => {
    if (
      !uiUpdates ||
      event.sender !== mainWindow?.webContents ||
      !event.senderFrame?.url.startsWith("app://./")
    )
      return;
    if (uiReadyTimer) clearTimeout(uiReadyTimer);
    uiReadyTimer = null;
    void uiUpdates
      .markHealthy()
      .catch((error) =>
        console.error("[ui-update] health check failed", error),
      );
  });
  ipcMain.handle("app:api-port", () => getSidecarPort());
  ipcMain.handle("app:runtime-token", async (event) => {
    const url = event.senderFrame?.url ?? "";
    const trusted =
      url.startsWith("app://./") ||
      url.startsWith(`http://localhost:${process.env.WEB_PORT ?? "5173"}/`);
    if (!mainWindow || event.sender !== mainWindow.webContents || !trusted)
      throw new Error("Untrusted runtime credential request.");
    return (
      await fs.readFile(
        path.join(getDataRoot(), "runtime-access-token"),
        "utf8",
      )
    ).trim();
  });
  ipcMain.on("terminal:focus", (event, focused) => {
    if (event.sender === mainWindow?.webContents) {
      terminalFocused = focused === true;
      event.sender.setIgnoreMenuShortcuts(terminalFocused);
    }
  });
  ipcMain.on("menu:update-projects", (event, projects) => {
    if (event.sender !== mainWindow?.webContents || !Array.isArray(projects))
      return;
    updateProjectsMenu(
      projects
        .filter(
          (item) =>
            item &&
            typeof item.id === "string" &&
            typeof item.name === "string",
        )
        .slice(0, 250),
    );
  });
  ipcMain.on("menu:update-state", (event, state) => {
    if (
      event.sender !== mainWindow?.webContents ||
      !state ||
      typeof state !== "object"
    )
      return;
    updateMenuState({
      projectId: typeof state.projectId === "string" ? state.projectId : null,
      hasSession: state.hasSession === true,
      hasViewer: state.hasViewer === true,
      inWork: state.inWork === true,
      inWiki: state.inWiki === true,
      dark: state.dark === true,
    });
  });
}

async function bootstrap(): Promise<void> {
  registerIPC();
  if (
    !uiUpdates &&
    app.isPackaged &&
    (process.platform === "darwin" || process.platform === "win32")
  ) {
    try {
      const updates = new UiUpdates();
      await updates.initialize();
      uiUpdates = updates;
      setUiUpdateAction(() => void uiUpdates?.check(true));
    } catch (error) {
      // A broken update cache must never prevent the bundled app from opening.
      console.error(
        "[ui-update] updater unavailable; using bundled interface",
        error,
      );
      uiUpdates = null;
      setUiUpdateAction(null);
    }
  } else buildAppMenu();

  // Register custom protocol to serve frontend assets over app:// scheme.
  // This is required because <script type="module"> does not work with file:// protocol.
  if (!protocolRegistered) {
    protocol.handle("app", async (request) => {
      const url = new URL(request.url);
      const root = path.resolve(uiUpdates?.root ?? getResourcePath("dist"));
      const filePath = path.resolve(
        root,
        decodeURIComponent(url.pathname).replace(/^\/+/, ""),
      );
      if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`))
        return new Response("Forbidden", { status: 403 });
      try {
        if ((await fs.stat(filePath)).isFile())
          return net.fetch(pathToFileURL(filePath).href);
      } catch {
        /* SPA route or missing asset. */
      }
      if (!path.extname(filePath) || filePath === root)
        return net.fetch(pathToFileURL(path.join(root, "index.html")).href);
      return new Response("Not found", { status: 404 });
    });
    protocolRegistered = true;
  }

  const externalApi = process.env.ELECTRON_SKIP_SIDECAR === "1";

  if (!externalApi) {
    console.log("[electron] starting API sidecar...");
    const port = await startSidecar();
    console.log(`[electron] API ready on port ${port}`);
  } else {
    console.log("[electron] using external API server");
  }

  mainWindow = createWindow();

  if (isDev) {
    const webPort = process.env.WEB_PORT || "5173";
    mainWindow.loadURL(`http://localhost:${webPort}`);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    if (uiUpdates?.store.needsHealthCheck) {
      uiReadyTimer = setTimeout(() => {
        if (mainWindow) void recoverUi(mainWindow);
      }, 30_000);
      uiReadyTimer.unref?.();
    }
    try {
      await mainWindow.loadURL("app://./index.html");
    } catch (error) {
      if (!(await uiUpdates?.rollback())) throw error;
      if (uiReadyTimer) clearTimeout(uiReadyTimer);
      await mainWindow.loadURL("app://./index.html");
    }
    uiUpdates?.start(mainWindow);
  }
}

if (gotLock)
  app
    .whenReady()
    .then(bootstrap)
    .catch((err) => {
      console.error("[electron] failed to bootstrap", err);
      dialog.showErrorBox(
        "Synax failed to start",
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      );
      app.quit();
    });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (gotLock && BrowserWindow.getAllWindows().length === 0) {
    bootstrap();
  }
});

app.on("before-quit", () => {
  uiUpdates?.stop();
  stopSidecar();
});
