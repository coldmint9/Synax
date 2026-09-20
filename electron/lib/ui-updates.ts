import { app, dialog, type BrowserWindow } from "electron";
import path from "node:path";
import { getResourcePath } from "./data-paths.js";
import { findUiRelease } from "./ui-update-feed.js";
import { UiUpdateStore } from "./ui-update-store.js";

export class UiUpdates {
  readonly store: UiUpdateStore;
  private inFlight: Promise<void> | null = null;
  private window: BrowserWindow | null = null;

  constructor() {
    this.store = new UiUpdateStore(
      path.join(app.getPath("userData"), "ui-updates", app.getVersion()),
      path.resolve(getResourcePath("dist")),
      app.getVersion(),
    );
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
  }
  get root(): string {
    return this.store.root;
  }
  async markHealthy(): Promise<void> {
    await this.store.markHealthy();
  }
  async rollback(): Promise<boolean> {
    return this.store.rollback();
  }

  start(window: BrowserWindow): void {
    this.window = window;
  }

  check(manual: boolean): Promise<void> {
    if (this.inFlight)
      return manual
        ? this.inFlight.then(() => this.check(true))
        : this.inFlight;
    const task = this.runCheck(manual).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = task;
    return task;
  }

  private async message(options: Electron.MessageBoxOptions): Promise<number> {
    const owner =
      this.window && !this.window.isDestroyed() ? this.window : undefined;
    return (
      await (owner
        ? dialog.showMessageBox(owner, options)
        : dialog.showMessageBox(options))
    ).response;
  }

  private async promptRestart(version: string): Promise<void> {
    const response = await this.message({
      type: "info",
      title: "界面更新已就绪",
      message: `Synax 界面 ${version} 已下载。`,
      detail: "重启后应用新界面；当前任务不会被强制中断。",
      buttons: ["稍后", "立即重启"],
      defaultId: 0,
      cancelId: 0,
    });
    if (response === 1) {
      app.relaunch();
      app.quit();
    }
  }

  private async runCheck(manual: boolean): Promise<void> {
    try {
      if (this.store.pendingVersion) {
        if (manual) await this.promptRestart(this.store.pendingVersion);
        return;
      }
      const release = await findUiRelease(
        app.getVersion(),
        this.store.currentVersion,
        this.store.rejected,
      );
      if (!release) {
        if (manual)
          await this.message({
            type: "info",
            title: "检查更新",
            message: "当前已是最新的兼容界面。",
            buttons: ["确定"],
          });
        return;
      }
      await this.store.prepare(release);
      await this.promptRestart(release.manifest.version);
    } catch (error) {
      console.error("[ui-update] check failed", error);
      if (manual)
        await this.message({
          type: "error",
          title: "检查更新失败",
          message: "无法完成更新检查或下载。",
          detail: error instanceof Error ? error.message : String(error),
          buttons: ["确定"],
        });
    }
  }
}
