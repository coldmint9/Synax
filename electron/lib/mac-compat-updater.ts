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

const run = promisify(execFile);
const { app } = electron;

/** Only known unsigned/ad-hoc/self-signed apps use the compatibility installer.
 * Unexpected inspection errors must not silently downgrade a signed app. */
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
export class AdHocMacUpdater extends AppUpdater {
  private readonly transfer = new ElectronHttpExecutor((info, callback) => this.emit("login", info, callback));
  private downloaded: { file: string; info: UpdateInfo } | null = null;
  private installTask: Promise<void> | null = null;

  constructor() { super(undefined); }

  protected async doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    this.downloaded = null;
    const { provider, info } = options.updateInfoAndProvider;
    const fileInfo = findFile(provider.resolveFiles(info), "zip");
    if (!fileInfo || !fileInfo.url.pathname.endsWith(".zip")) throw new Error("macOS update requires an application ZIP");
    const files = await this.executeDownload({
      fileExtension: "zip", downloadUpdateOptions: options, fileInfo,
      task: (destination, downloadOptions) => this.transfer.download(fileInfo.url, destination, downloadOptions),
      done: async (event) => { this.dispatchUpdateDownloaded(event); },
    });
    if (files.length !== 1) throw new Error("macOS update requires exactly one application ZIP");
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
      artifact: archive, updateArchive: archive,
    }, process.execPath, directory);
    await launchMacInstaller(installation, directory, process.pid, [
      `--user-data-dir=${app.getPath("userData")}`,
    ]);
    // The helper waits for this process to exit; preparation failures keep it open.
    app.quit();
  }
}
