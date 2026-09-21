import {
  app,
  dialog,
  type BrowserWindow,
  type MessageBoxOptions,
} from "electron";
import { promises as fs } from "original-fs";
import path from "node:path";
import { finishMacInstallation } from "./mac-desktop-update.js";
import { UpdaterController } from "../updater/controller.js";
import type { UpdaterRequest, UpdaterState } from "../updater/contract.js";

/**
 * Runs desktop update checks and downloads in the main process. The only
 * detached process left in the flow is the tiny macOS shell swapper, which is
 * required because a running .app cannot replace itself.
 */
export class DesktopUpdates {
  private readonly controller: UpdaterController;
  private readonly initialized: Promise<void>;
  private window: BrowserWindow | null = null;
  private opening: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private promptedVersion: string | null = null;
  private confirming: Promise<void> | null = null;
  private lastPhase: UpdaterState["phase"] | null = null;
  private lastPublished = 0;

  constructor(uiVersion: () => string | null) {
    const profile = app.getPath("userData");
    const request: UpdaterRequest = {
      currentVersion: app.getVersion(),
      uiVersion: uiVersion(),
      executable: process.execPath,
      profile,
      parentPid: process.pid,
    };
    this.controller = new UpdaterController(
      request,
      (state) => this.publish(state),
      undefined,
      async () => {
        app.quit();
      },
    );
    this.initialized = this.controller.initialize();
  }

  start(window: BrowserWindow): void {
    this.window = window;
    this.lastPhase = null;
    this.publish(this.controller.snapshot());
    if (this.timer) return;
    this.startTimer = setTimeout(() => void this.check(false), 30_000);
    this.timer = setInterval(() => void this.check(false), 12 * 60 * 60_000);
    this.startTimer.unref?.();
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.startTimer) clearTimeout(this.startTimer);
    this.timer = this.startTimer = null;
    if (this.window && !this.window.isDestroyed())
      this.window.setProgressBar(-1);
    this.window = null;
  }

  snapshot(): UpdaterState {
    return this.controller.snapshot();
  }

  private send(channel: string, state?: UpdaterState): void {
    const window = this.window;
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send(channel, state);
  }

  private publish(state: UpdaterState): void {
    const now = Date.now();
    if (
      state.phase === "downloading" &&
      this.lastPhase === state.phase &&
      state.progress < 1 &&
      now - this.lastPublished < 100
    )
      return;
    this.lastPhase = state.phase;
    this.lastPublished = now;
    this.send("updates:state", state);
    if (this.window && !this.window.isDestroyed())
      this.window.setProgressBar(
        state.phase === "downloading"
          ? state.progress
          : state.phase === "verifying"
            ? 2
            : -1,
      );
  }

  async markHealthy(): Promise<void> {
    const directory = path.join(app.getPath("userData"), "desktop-updates");
    if (process.platform === "darwin")
      await finishMacInstallation(
        directory,
        process.execPath,
        app.getVersion(),
      );
    else {
      const marker = path.join(directory, "pending-windows.json");
      let pending;
      try {
        pending = JSON.parse(await fs.readFile(marker, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (
        pending.version === app.getVersion() &&
        pending.installRoot === path.resolve(process.execPath, "../..")
      )
        await fs.rm(marker);
    }
  }

  private showDialog(
    options: MessageBoxOptions,
  ): Promise<Electron.MessageBoxReturnValue> {
    return this.window && !this.window.isDestroyed()
      ? dialog.showMessageBox(this.window, options)
      : dialog.showMessageBox(options);
  }

  check(manual: boolean): Promise<void> {
    if (manual) this.send("updates:show");
    if (this.opening) return this.opening;
    this.opening = this.runCheck(manual)
      .catch(async (error) => {
        console.error("[desktop-update] failed", error);
        if (manual)
          await this.showDialog({
            type: "error",
            title: "检查更新失败",
            message: "无法完成 Synax 更新检查。",
            detail: error instanceof Error ? error.message : String(error),
            buttons: ["确定"],
          });
      })
      .finally(() => {
        this.opening = null;
      });
    return this.opening;
  }

  private async runCheck(manual: boolean): Promise<void> {
    await this.initialized;
    if (this.controller.state.phase !== "ready") await this.controller.check();

    if (this.controller.state.phase === "current") {
      if (manual)
        await this.showDialog({
          type: "info",
          title: "检查更新",
          message: "当前已是最新版本。",
          buttons: ["确定"],
        });
      return;
    }

    if (this.controller.state.phase === "available")
      await this.controller.download();
    if (this.controller.state.phase !== "ready") {
      if (manual && this.controller.state.phase === "error")
        throw new Error(this.controller.state.message);
      return;
    }

    await this.confirmInstallation(manual);
  }

  async install(): Promise<void> {
    await this.initialized;
    await this.confirmInstallation(true);
  }

  private confirmInstallation(force: boolean): Promise<void> {
    if (this.confirming) return this.confirming;
    const version = this.controller.state.availableVersion;
    if (
      this.controller.state.phase !== "ready" ||
      !version ||
      (!force && version === this.promptedVersion)
    )
      return Promise.resolve();
    this.confirming = this.promptInstallation(version).finally(() => {
      this.confirming = null;
    });
    return this.confirming;
  }

  private async promptInstallation(version: string): Promise<void> {
    this.promptedVersion = version;
    const answer = await this.showDialog({
      type: "question",
      title: "发现 Synax 更新",
      message: `Synax ${version} 已准备好安装。现在重启更新吗？`,
      detail:
        "安装包已完整下载、校验并缓存。确认后 Synax 会退出，关闭正在运行的任务和终端，并在完成后自动重新启动。选择稍后会保留安装包。",
      buttons: ["稍后", "安装并重启"],
      defaultId: 0,
      cancelId: 0,
    });
    if (answer.response === 1) {
      await this.controller.install();
      return;
    }
  }
}
