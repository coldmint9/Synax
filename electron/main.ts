import {
  SessionNotifications,
  isTrustedNotificationSender,
} from "./lib/session-notifications.js";
import { isTerminalSystemShortcut } from "./lib/terminal-shortcuts.js";
import fs from "node:fs/promises";
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  protocol,
  net,
  nativeTheme,
} from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startSidecar, stopSidecar } from "./lib/node-sidecar.js";
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
import { DesktopUpdates } from "./lib/desktop-updates.js";
import { configureUpdateNetwork } from "./lib/update-network.js";
import { UpdateSettingsStore } from "./lib/update-settings-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let windowOpening: Promise<void> | null = null;
async function ensureMainWindow(): Promise<BrowserWindow | null> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    windowOpening ??= bootstrap().finally(() => {
      windowOpening = null;
    });
    await windowOpening;
  }
  return mainWindow;
}
const sessionNotifications = new SessionNotifications(
  () => mainWindow,
  ensureMainWindow,
  isDev
    ? getResourcePath("electron", "resources", "icon.png")
    : getResourcePath("icon.png"),
);
let terminalFocused = false;
let uiUpdates: UiUpdates | null = null;
let desktopUpdates: DesktopUpdates | null = null;
let updateSettings: UpdateSettingsStore;
let uiReadyTimer: NodeJS.Timeout | null = null;
const terminalAccessibilitySupportEnabled = (
  systemEnabled = app.accessibilitySupportEnabled,
) => process.env.SYNAX_E2E_TERMINAL === "1" || systemEnabled;

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
    icon: isDev
      ? getResourcePath(
          "electron",
          "resources",
          process.platform === "win32" ? "icon.ico" : "icon.png",
        )
      : getResourcePath(process.platform === "win32" ? "icon.ico" : "icon.png"),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 14, y: 18 } }
      : {}),
    show: false,
    // A solid backing surface avoids native material and transparent-window
    // composition during streaming, resize, and renderer navigation.
    transparent: false,
    opacity: 1,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0f141d" : "#f9f9f9",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
    },
  });

  // The same srcdoc renderer is used on desktop; subframes never navigate away.
  win.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !["about:blank", "about:srcdoc"].includes(event.url)) event.preventDefault();
  });

  win.webContents.on("did-start-loading", () =>
    sessionNotifications.setRendererReady(false),
  );
  win.on("closed", () => sessionNotifications.setRendererReady(false));

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
  const trustedNotificationSender = (
    event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
  ) =>
    isTrustedNotificationSender(
      event,
      mainWindow,
      isDev,
      process.env.WEB_PORT ?? "5173",
    );
  ipcMain.handle(
    "notifications:show",
    (event, payload) =>
      trustedNotificationSender(event) && sessionNotifications.show(payload),
  );
  ipcMain.on("notifications:enabled", (event, enabled) => {
    if (trustedNotificationSender(event) && typeof enabled === "boolean")
      sessionNotifications.setEnabled(enabled);
  });
  ipcMain.on("notifications:renderer-ready", (event, ready) => {
    if (trustedNotificationSender(event) && typeof ready === "boolean")
      sessionNotifications.setRendererReady(ready);
  });
  ipcMain.on("notifications:dismiss", (event, sessionId) => {
    if (trustedNotificationSender(event) && typeof sessionId === "string")
      sessionNotifications.dismiss(sessionId);
  });
  ipcMain.handle("dialog:open", (_e, options) =>
    dialog.showOpenDialog(options),
  );
  ipcMain.handle("dialog:save", (_e, options) =>
    dialog.showSaveDialog(options),
  );
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("updates:get-network", (event) => {
    if (!trustedNotificationSender(event))
      throw new Error("Untrusted update settings sender");
    return updateSettings.settings;
  });
  ipcMain.handle("updates:set-network", async (event, value: unknown) => {
    if (!trustedNotificationSender(event))
      throw new Error("Untrusted update settings sender");
    const settings = await updateSettings.save(value);
    configureUpdateNetwork(settings);
    return settings;
  });
  ipcMain.handle("updates:state", (event) => {
    if (!trustedNotificationSender(event))
      throw new Error("Untrusted update sender");
    return desktopUpdates?.snapshot() ?? null;
  });
  ipcMain.handle("updates:check", (event) => {
    if (!trustedNotificationSender(event))
      throw new Error("Untrusted update sender");
    if (!desktopUpdates)
      throw new Error("Desktop updates are unavailable in this build");
    void desktopUpdates.check(true);
  });
  ipcMain.handle("updates:install", async (event) => {
    if (!trustedNotificationSender(event))
      throw new Error("Untrusted update sender");
    if (!desktopUpdates)
      throw new Error("Desktop updates are unavailable in this build");
    await desktopUpdates.install();
  });
  ipcMain.handle("app:accessibility-support-enabled", () =>
    terminalAccessibilitySupportEnabled(),
  );
  ipcMain.on("app:ui-ready", (event) => {
    if (
      event.sender !== mainWindow?.webContents ||
      !event.senderFrame?.url.startsWith("app://./")
    )
      return;
    if (uiReadyTimer) clearTimeout(uiReadyTimer);
    uiReadyTimer = null;
    void desktopUpdates
      ?.markHealthy()
      .catch((error) =>
        console.error("[desktop-update] health check failed", error),
      );
    void uiUpdates
      ?.markHealthy()
      .catch((error) =>
        console.error("[ui-update] health check failed", error),
      );
  });
  ipcMain.handle("app:api-port", async (event) => {
    if (!trustedNotificationSender(event))
      throw new Error("Untrusted runtime port request.");
    // A slow backend is not evidence of a broken downloaded UI bundle.
    if (uiReadyTimer) clearTimeout(uiReadyTimer);
    uiReadyTimer = null;
    const port =
      process.env.ELECTRON_SKIP_SIDECAR === "1"
        ? Number(process.env.PORT || "3210")
        : await startSidecar();
    armUiReadyTimer();
    return port;
  });
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
    // Keep the native backing color in sync with the renderer's explicit theme.
    const backgroundColor = state.dark === true ? "#0f141d" : "#f9f9f9";
    if (mainWindow?.getBackgroundColor().toLowerCase() !== backgroundColor)
      mainWindow?.setBackgroundColor(backgroundColor);
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

function armUiReadyTimer(): void {
  if (uiReadyTimer) clearTimeout(uiReadyTimer);
  uiReadyTimer = null;
  if (!uiUpdates?.store.needsHealthCheck) return;
  uiReadyTimer = setTimeout(() => {
    if (mainWindow) void recoverUi(mainWindow);
  }, 30_000);
  uiReadyTimer.unref?.();
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
    } catch (error) {
      // A broken update cache must never prevent the bundled app from opening.
      console.error(
        "[ui-update] updater unavailable; using bundled interface",
        error,
      );
      uiUpdates = null;
    }
  } else buildAppMenu();
  if (
    !desktopUpdates &&
    app.isPackaged &&
    ["darwin", "win32"].includes(process.platform)
  ) {
    desktopUpdates = new DesktopUpdates(
      () => uiUpdates?.store.currentVersion ?? null,
    );
    setUiUpdateAction(() => void desktopUpdates?.check(true));
  }

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

  // Paint the shell before waiting for the backend. The renderer requests the
  // actual bound port over IPC and owns the retryable connection gate.
  mainWindow = createWindow();

  if (isDev) {
    const webPort = process.env.WEB_PORT || "5173";
    mainWindow.loadURL(`http://localhost:${webPort}`);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    armUiReadyTimer();
    try {
      await mainWindow.loadURL("app://./index.html");
    } catch (error) {
      if (!(await uiUpdates?.rollback())) throw error;
      if (uiReadyTimer) clearTimeout(uiReadyTimer);
      await mainWindow.loadURL("app://./index.html");
    }
    uiUpdates?.start(mainWindow);
    desktopUpdates?.start(mainWindow);
  }
}

if (gotLock)
  app
    .whenReady()
    .then(async () => {
      updateSettings = new UpdateSettingsStore(
        path.join(app.getPath("userData"), "update-network.json"),
      );
      await updateSettings.initialize();
      configureUpdateNetwork(updateSettings.settings);
    })
    .then(ensureMainWindow)
    .catch((err) => {
      console.error("[electron] failed to bootstrap", err);
      dialog.showErrorBox(
        "Synax failed to start",
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      );
      app.quit();
    });

app.on(
  "accessibility-support-changed",
  (_event, accessibilitySupportEnabled) => {
    const win = mainWindow;
    if (win && !win.isDestroyed())
      win.webContents.send(
        "app:accessibility-support-changed",
        terminalAccessibilitySupportEnabled(accessibilitySupportEnabled),
      );
  },
);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (gotLock && BrowserWindow.getAllWindows().length === 0) {
    void ensureMainWindow().catch((error) => {
      console.error("[electron] failed to reopen the window", error);
    });
  }
});

app.on("before-quit", () => {
  sessionNotifications.dispose();
  desktopUpdates?.stop();
  stopSidecar();
});
