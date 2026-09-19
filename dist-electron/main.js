import fs from "node:fs/promises";
import { app, BrowserWindow, ipcMain, dialog, protocol, net } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startSidecar, stopSidecar, getSidecarPort, } from "./lib/node-sidecar.js";
import { getDataRoot, getResourcePath } from "./lib/data-paths.js";
import { loadWindowState, saveWindowState } from "./lib/window-state.js";
import { buildAppMenu, updateProjectsMenu } from "./menu.js";
import { handleSquirrelEvent } from "./lib/squirrel-startup.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = !app.isPackaged;
let mainWindow = null;
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
        if (mainWindow.isMinimized())
            mainWindow.restore();
        mainWindow.focus();
    }
});
function createWindow() {
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
    const showWindow = () => {
        if (!win.isDestroyed() && !win.isVisible()) {
            win.show();
        }
    };
    win.on("ready-to-show", showWindow);
    win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
        console.error("[electron] renderer failed to load", {
            errorCode,
            errorDescription,
            validatedURL,
        });
        showWindow();
    });
    win.webContents.on("render-process-gone", (_event, details) => {
        console.error("[electron] renderer process gone", details);
        showWindow();
    });
    const fallbackTimer = setTimeout(showWindow, 5000);
    fallbackTimer.unref?.();
    win.on("close", () => {
        const bounds = win.getNormalBounds();
        saveWindowState({ ...bounds, isMaximized: win.isMaximized() });
    });
    if (state.isMaximized)
        win.maximize();
    return win;
}
let protocolRegistered = false;
let ipcRegistered = false;
function registerIPC() {
    if (ipcRegistered)
        return;
    ipcRegistered = true;
    ipcMain.handle("dialog:open", (_e, options) => dialog.showOpenDialog(options));
    ipcMain.handle("dialog:save", (_e, options) => dialog.showSaveDialog(options));
    ipcMain.handle("app:version", () => app.getVersion());
    ipcMain.handle("app:api-port", () => getSidecarPort());
    ipcMain.handle("app:runtime-token", async (event) => {
        const url = event.senderFrame?.url ?? "";
        const trusted = url.startsWith("app://./") ||
            url.startsWith(`http://localhost:${process.env.WEB_PORT ?? "5173"}/`);
        if (!mainWindow || event.sender !== mainWindow.webContents || !trusted)
            throw new Error("Untrusted runtime credential request.");
        return (await fs.readFile(path.join(getDataRoot(), "runtime-access-token"), "utf8")).trim();
    });
    ipcMain.on("menu:update-projects", (_e, projects) => {
        updateProjectsMenu(projects);
    });
}
async function bootstrap() {
    registerIPC();
    buildAppMenu();
    // Register custom protocol to serve frontend assets over app:// scheme.
    // This is required because <script type="module"> does not work with file:// protocol.
    if (!protocolRegistered) {
        protocol.handle("app", async (request) => {
            const url = new URL(request.url);
            const root = path.resolve(getResourcePath("dist"));
            const filePath = path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ""));
            if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`))
                return new Response("Forbidden", { status: 403 });
            try {
                if ((await fs.stat(filePath)).isFile())
                    return net.fetch(pathToFileURL(filePath).href);
            }
            catch {
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
    }
    else {
        console.log("[electron] using external API server");
    }
    mainWindow = createWindow();
    if (isDev) {
        const webPort = process.env.WEB_PORT || "5173";
        mainWindow.loadURL(`http://localhost:${webPort}`);
        mainWindow.webContents.openDevTools({ mode: "detach" });
    }
    else {
        await mainWindow.loadURL("app://./index.html");
    }
}
if (gotLock)
    app
        .whenReady()
        .then(bootstrap)
        .catch((err) => {
        console.error("[electron] failed to bootstrap", err);
        dialog.showErrorBox("Synax failed to start", err instanceof Error ? (err.stack ?? err.message) : String(err));
        app.quit();
    });
app.on("window-all-closed", () => {
    if (process.platform !== "darwin")
        app.quit();
});
app.on("activate", () => {
    if (gotLock && BrowserWindow.getAllWindows().length === 0) {
        bootstrap();
    }
});
app.on("before-quit", () => {
    stopSidecar();
});
