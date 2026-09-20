import { app, autoUpdater, dialog, type BrowserWindow } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import {
  downloadDesktopRelease,
  findDesktopRelease,
  hashFile,
  type DesktopArch,
  type DesktopPlatform,
  type DesktopRelease,
} from "./desktop-update-feed.js";
import {
  checkMacInstallLocation,
  finishMacInstallation,
  launchMacInstaller,
  prepareMacInstallation,
} from "./mac-desktop-update.js";

export async function prepareWindowsUpdate(
  directory: string,
  file: string,
): Promise<void> {
  await fs.access(path.resolve(process.execPath, "../../Update.exe"));
  // Squirrel reads a local feed containing only our SHA-256 verified package.
  // Its RELEASES format additionally requires a SHA-1 digest.
  await fs.writeFile(
    path.join(directory, "RELEASES"),
    `${await hashFile(file, "sha1")} ${path.basename(file)} ${(await fs.stat(file)).size}\n`,
  );
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      autoUpdater.removeListener("error", failed);
      autoUpdater.removeListener("update-downloaded", downloaded);
      autoUpdater.removeListener("update-not-available", unavailable);
      error ? reject(error) : resolve();
    };
    const failed = (error: Error) => finish(error);
    const downloaded = () => finish();
    const unavailable = () =>
      finish(
        new Error("Squirrel did not accept the downloaded desktop version"),
      );
    autoUpdater.once("error", failed);
    autoUpdater.once("update-downloaded", downloaded);
    autoUpdater.once("update-not-available", unavailable);
    try {
      autoUpdater.setFeedURL({ url: directory });
      autoUpdater.checkForUpdates();
    } catch (error) {
      finish(error as Error);
    }
  });
}

export class DesktopUpdates {
  private pending: {
    release: DesktopRelease;
    file: string;
    directory: string;
  } | null = null;
  private offered: string | null = null;
  private window: BrowserWindow | null = null;
  private readonly directory = path.join(
    app.getPath("userData"),
    "desktop-updates",
  );

  setWindow(window: BrowserWindow): void {
    this.window = window;
  }

  async markHealthy(): Promise<void> {
    if (process.platform === "darwin")
      await finishMacInstallation(
        this.directory,
        process.execPath,
        app.getVersion(),
      );
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

  private progress(fraction: number): void {
    if (this.window && !this.window.isDestroyed())
      this.window.setProgressBar(fraction);
  }

  private async interactive(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.offered = null;
      console.error("[desktop-update] installation failed", error);
      await this.message({
        type: "error",
        title: "Synax 升级失败",
        message: "无法完成下载或安装，当前应用仍可继续使用。",
        detail: error instanceof Error ? error.message : String(error),
        buttons: ["确定"],
      });
    } finally {
      this.progress(-1);
    }
  }

  // True means a full update takes precedence over any UI-only update.
  async check(manual: boolean): Promise<boolean> {
    if (
      !app.isPackaged ||
      !["darwin", "win32"].includes(process.platform) ||
      !["arm64", "x64"].includes(process.arch)
    )
      return false;
    if (this.pending) {
      if (manual) await this.interactive(() => this.promptRestart());
      return true;
    }
    const release = await findDesktopRelease(
      app.getVersion(),
      process.platform as DesktopPlatform,
      process.arch as DesktopArch,
    );
    if (!release) return false;
    if (!manual && this.offered === release.manifest.version) return true;
    this.offered = release.manifest.version;
    const response = await this.message({
      type: "info",
      title: "发现 Synax 更新",
      message: `Synax ${release.manifest.version} 可用（当前 ${app.getVersion()}）。`,
      detail: `此次更新包含内核、后台服务和界面，下载大小约 ${Math.ceil(release.manifest.artifact.size / 1024 ** 2)} MB。下载完成后可选择何时重启。`,
      buttons: ["稍后", "下载更新"],
      defaultId: 1,
      cancelId: 0,
    });
    if (response !== 1) return true;
    await this.interactive(async () => {
      if (process.platform === "darwin")
        await checkMacInstallLocation(process.execPath);
      else {
        try {
          await fs.access(path.resolve(process.execPath, "../../Update.exe"));
        } catch {
          throw new Error(
            "请使用 Synax Setup 安装应用后再在线升级；便携 ZIP 版本请手动更新。",
          );
        }
      }
      const directory = path.join(
        this.directory,
        `${release.manifest.version}-${release.manifest.platform}-${release.manifest.arch}`,
      );
      this.progress(0);
      const file = await downloadDesktopRelease(
        release,
        directory,
        (fraction) => this.progress(fraction),
      );
      this.progress(2);
      if (process.platform === "win32")
        await prepareWindowsUpdate(directory, file);
      this.pending = { release, file, directory };
      this.progress(-1);
      await this.promptRestart();
    });
    return true;
  }

  private async promptRestart(): Promise<void> {
    const pending = this.pending!;
    const response = await this.message({
      type: "info",
      title: "Synax 更新已就绪",
      message: `Synax ${pending.release.manifest.version} 已下载并校验。`,
      detail:
        "重启将关闭当前窗口、后台任务和终端，并更新整个应用。项目、设置和历史数据会保留，请在任务结束后重启。",
      buttons: ["稍后", "立即重启并升级"],
      defaultId: 0,
      cancelId: 0,
    });
    if (response !== 1) return;
    if (process.platform === "darwin") {
      this.progress(2);
      const installation = await prepareMacInstallation(
        pending.file,
        pending.release.manifest,
        process.execPath,
        pending.directory,
      );
      await launchMacInstaller(installation, this.directory);
      app.quit();
    } else autoUpdater.quitAndInstall();
  }
}
