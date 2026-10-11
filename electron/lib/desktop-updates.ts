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
import { updateFailureMessage } from "../updater/update-errors.js";

/**
 * Adapts electron-updater to the renderer's silent background update flow.
 * The framework owns download caching, native installation and quit handoff.
 */
export class DesktopUpdates {
  private readonly controller: UpdaterController;
  private readonly initialized: Promise<void>;
  private window: BrowserWindow | null = null;
  private opening: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
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
    if (state.phase === "error" && this.lastPhase !== "error")
      this.send("updates:show");
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
    await this.initialized;
    await this.controller.markHealthy();
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
            detail: updateFailureMessage(error),
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
    if (
      this.controller.state.phase !== "ready" &&
      manual &&
      this.controller.state.phase === "error"
    )
      throw new Error(this.controller.state.message);
  }

  async install(): Promise<void> {
    await this.initialized;
    if (this.controller.state.phase !== "ready") return;
    await this.controller.install();
  }
}
