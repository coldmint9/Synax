import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { validateUpdaterRequest, type UpdaterAction } from "./contract.js";
import { controlHost, UpdaterController } from "./controller.js";

async function boot(): Promise<void> {
  const requestFile = process.argv
    .find((arg) => arg.startsWith("--request="))
    ?.slice(10);
  if (!requestFile || !path.isAbsolute(requestFile))
    throw new Error("请从 Synax 的“软件更新”菜单打开内置升级器。");
  const request = validateUpdaterRequest(
    JSON.parse(await fs.readFile(requestFile, "utf8")),
  );
  if (!path.isAbsolute(request.profile) || !path.isAbsolute(request.executable))
    throw new Error("Invalid updater paths");
  const updaterProfile = path.join(request.profile, "updater-profile");
  await fs.mkdir(updaterProfile, { recursive: true });
  app.setPath("userData", updaterProfile);
  if (process.platform === "win32") app.setAppUserModelId("com.Synax.updater");
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  let window: BrowserWindow | null = null;
  let background = request.background;
  const show = () => {
    background = false;
    if (window && !window.isDestroyed()) {
      window.show();
      window.focus();
    }
  };
  app.on("second-instance", show);
  await app.whenReady();
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    width: 640,
    height: 720,
    minWidth: 520,
    minHeight: 580,
    title: "Synax Updater",
    icon: path.join(
      process.resourcesPath,
      process.platform === "win32" ? "icon.ico" : "icon.png",
    ),
    show: !request.background,
    autoHideMenuBar: true,
    backgroundColor: "#101216",
    webPreferences: {
      preload: path.join(app.getAppPath(), "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const controller = new UpdaterController(request, (state) => {
    if (!window || window.isDestroyed()) return;
    window.webContents.send("updater:state", state);
    window.setProgressBar(
      state.phase === "downloading"
        ? state.progress
        : state.phase === "installing"
          ? 2
          : -1,
    );
  });
  const trusted = (event: Electron.IpcMainInvokeEvent) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("Untrusted updater IPC");
  };
  ipcMain.handle("updater:state", (event) => {
    trusted(event);
    return controller.snapshot();
  });
  ipcMain.handle("updater:action", async (event, action: UpdaterAction) => {
    trusted(event);
    if (action === "check") await controller.check();
    else if (action === "download") await controller.download();
    else if (
      action === "install" &&
      !controller.locked &&
      controller.state.phase === "ready"
    ) {
      const answer = await dialog.showMessageBox(window!, {
        type: "question",
        title: "安装 Synax 更新",
        message: `安装 Synax ${controller.state.availableVersion}？`,
        detail:
          "Synax 将退出，正在运行的任务和终端会关闭。升级器会继续运行，安装完成后重新打开 Synax。",
        buttons: ["稍后", "安装并重启"],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response === 1) await controller.install();
    } else if (action === "release" && controller.state.availableVersion) {
      await shell.openExternal(
        `https://github.com/coldmint9/Synax/releases/tag/v${controller.state.availableVersion}`,
      );
    } else if (action === "ui-check") {
      try {
        await controlHost(request, "ui-check", true);
      } catch {
        await dialog.showMessageBox(window!, {
          message: "请先打开 Synax，再检查界面更新。",
          buttons: ["确定"],
        });
      }
    }
    return controller.snapshot();
  });
  window.on("close", (event) => {
    if (controller.locked) {
      event.preventDefault();
      window?.hide();
    }
  });
  const watcher = setInterval(() => {
    void fs
      .unlink(`${requestFile}.show`)
      .then(show)
      .catch(() => {});
  }, 500);
  watcher.unref();
  app.on("before-quit", () => clearInterval(watcher));
  app.on("window-all-closed", () => app.quit());
  await controller.initialize();
  await window.loadFile(path.join(app.getAppPath(), "index.html"));
  await controller.check();
  if (background) {
    if (["available", "ready"].includes(controller.state.phase)) show();
    else {
      if (controller.state.phase === "current")
        await controlHost(request, "ui-check").catch(() => {});
      app.quit();
    }
  }
}
void boot().catch(async (error) => {
  console.error("[updater] startup failed", error);
  await app.whenReady();
  dialog.showErrorBox(
    "Synax Updater",
    error instanceof Error ? error.message : String(error),
  );
  app.quit();
});
