import electron from "electron";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { AppUpdater, type DownloadUpdateOptions } from "electron-updater/out/AppUpdater.js";
import { findFile } from "electron-updater/out/providers/Provider.js";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor.js";
import type { UpdateInfo } from "electron-updater";
import { macApplicationPath, prepareMacInstallation, launchMacInstaller } from "./mac-desktop-update.js";
import { assertProductIdentity } from "../updater/update-source.js";
import { effectiveUpdateSource } from "../updater/effective-update-source.js";

const run = promisify(execFile);
const { app } = electron;

/** Identify the installed signing mode; unexpected inspection errors must fail
 * before either signed or ad-hoc apps enter the shared DMG update path. */
export async function needsMacCompatibilityUpdater(executable: string): Promise<boolean> {
  let signature: string;
  try {
    signature = (await run("/usr/bin/codesign", ["-dv", "--verbose=4", macApplicationPath(executable)])).stderr;
  } catch (error) {
    if (/code object is not signed at all/.test(String((error as { stderr?: string }).stderr))) return true;
    throw error;
  }
  return !/^TeamIdentifier=(?!not set\s*$)\S+/m.test(signature);
}

/** Keep electron-updater's feed, cache, progress and SHA-512 validation, but
 * install through our bundle replacement helper instead of Squirrel.Mac. */
export class DmgMacUpdater extends AppUpdater {
  private readonly transfer = new ElectronHttpExecutor((info, callback) => this.emit("login", info, callback));
  private downloaded: { file: string; info: UpdateInfo } | null = null;
  private installTask: Promise<void> | null = null;

  constructor(private readonly resolveSource: () => string = effectiveUpdateSource) { super(undefined); }

  protected async doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    this.downloaded = null;
    this.resolveSource();
    const { provider, info } = options.updateInfoAndProvider;
    assertProductIdentity(info);
    const fileInfo = findFile(provider.resolveFiles(info), "dmg");
    if (!fileInfo || !fileInfo.url.pathname.endsWith(".dmg")) throw new Error("macOS update requires a DMG");
    const files = await this.executeDownload({
      fileExtension: "dmg", downloadUpdateOptions: options, fileInfo,
      task: (destination, downloadOptions) => this.transfer.download(fileInfo.url, destination, downloadOptions),
      done: async (event) => { this.dispatchUpdateDownloaded(event); },
    });
    if (files.length !== 1) throw new Error("macOS update requires exactly one DMG");
    this.downloaded = { file: files[0], info };
    return files;
  }

  override quitAndInstall(): Promise<void> {
    if (this.installTask) return this.installTask;
    this.installTask = this.installDownloaded().catch((error) => {
      this.installTask = null;
      throw error;
    });
    return this.installTask;
  }

  private async installDownloaded(): Promise<void> {
    if (!this.downloaded) throw new Error("请先下载更新安装包。");
    const { file, info } = this.downloaded;
    this.resolveSource();
    assertProductIdentity(info);
    const expected = info.files[0];
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size !== expected?.size) throw new Error("Desktop update checksum mismatch");
    const sha512 = createHash("sha512"), sha256 = createHash("sha256");
    for await (const bytes of createReadStream(file)) { sha512.update(bytes); sha256.update(bytes); }
    if (sha512.digest("base64") !== expected.sha512) throw new Error("Desktop update checksum mismatch");
    if (process.arch !== "arm64" && process.arch !== "x64") throw new Error("Unsupported macOS architecture");
    const archive = { name: path.basename(file), size: stat.size, sha256: sha256.digest("hex") };
    const directory = path.join(app.getPath("userData"), "desktop-updates");
    await fs.mkdir(directory, { recursive: true });
    const installation = await prepareMacInstallation(file, {
      format: 1, version: info.version, platform: "darwin", arch: process.arch,
      artifact: archive,
    }, process.execPath, directory);
    await launchMacInstaller(installation, directory, process.pid, [
      `--user-data-dir=${app.getPath("userData")}`,
    ]);
    // The helper waits for this process to exit; preparation failures keep it open.
    app.quit();
  }
}
