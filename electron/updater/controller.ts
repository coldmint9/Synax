import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { AppUpdater, UpdateInfo } from "electron-updater";
import type { UpdaterRequest, UpdaterState, UpdateHistory } from "./contract.js";
import { getUpdateProxyUrl } from "../lib/update-network.js";
import { frameworkChannel, DESKTOP_RELEASE_URL } from "./framework-feed.js";
import { updateFailureMessage } from "./update-errors.js";

export interface ControllerDependencies {
  create: () => Promise<AppUpdater>;
  configure: (updater: AppUpdater, proxy: string | null) => Promise<void>;
  eligible: () => Promise<void>;
}

async function eligibility(request: UpdaterRequest): Promise<void> {
  const { app } = await import("electron");
  if (!app.isPackaged) throw new Error("开发版本不执行自动更新，请安装正式发布版。");
  frameworkChannel(process.platform, process.arch);
  if (process.platform === "win32") {
    try {
      await fs.access(path.join(path.dirname(request.executable), "Uninstall Synax.exe"));
    } catch {
      throw new Error(`当前是 Squirrel 或便携版安装。请从 ${DESKTOP_RELEASE_URL} 下载 NSIS.exe 安装一次；后续可自动更新。卸载旧版时请保留用户数据。`);
    }
  } else {
    const { checkMacInstallLocation } = await import("../lib/mac-desktop-update.js");
    await checkMacInstallLocation(request.executable);
  }
}

function defaults(request: UpdaterRequest): ControllerDependencies {
  return {
    create: async () => (await import("../lib/desktop-updater-engine.js")).createFrameworkUpdater(process.platform),
    configure: async (updater, proxy) => (await import("../lib/desktop-updater-engine.js")).configureFrameworkFeed(updater, process.platform, process.arch, proxy),
    eligible: () => eligibility(request),
  };
}

interface PendingUpdate {
  version: string;
  fromVersion: string;
  executable: string;
  at: string;
}

export class UpdaterController {
  state: UpdaterState;
  private readonly directory: string;
  private readonly dependencies: ControllerDependencies;
  private updater: AppUpdater | null = null;
  private active: Promise<void> | null = null;
  private info: UpdateInfo | null = null;
  private file: string | null = null;
  private installing = false;
  private historyWrite: Promise<void> = Promise.resolve();

  constructor(
    private readonly request: UpdaterRequest,
    private readonly changed: (state: UpdaterState) => void = () => {},
    dependencies?: ControllerDependencies,
  ) {
    this.dependencies = dependencies ?? defaults(request);
    this.directory = path.join(request.profile, "desktop-updates");
    this.state = {
      phase: "idle", currentVersion: request.currentVersion, uiVersion: request.uiVersion,
      availableVersion: null, size: 0, progress: 0, notes: "", message: "尚未检查更新", history: [],
    };
  }

  snapshot(): UpdaterState { return structuredClone(this.state); }
  private update(value: Partial<UpdaterState>): void {
    Object.assign(this.state, value);
    this.changed(this.snapshot());
  }
  private fail(error: unknown): void {
    console.error("[desktop-update]", error);
    this.update({ phase: "error", message: updateFailureMessage(error) });
  }
  private async atomic(name: string, value: unknown): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, name);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async initialize(): Promise<void> {
    try {
      const entries = JSON.parse(await fs.readFile(path.join(this.directory, "history.json"), "utf8"));
      if (Array.isArray(entries)) this.update({ history: entries.filter((entry) =>
        entry && typeof entry.version === "string" && typeof entry.fromVersion === "string" &&
        typeof entry.at === "string" && ["installed", "failed"].includes(entry.outcome),
      ).slice(0, 30) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.fail(error);
    }
  }
  private record(pending: PendingUpdate, outcome: UpdateHistory["outcome"]): Promise<void> {
    const task = this.historyWrite.catch(() => {}).then(async () => {
      const entry = { version: pending.version, fromVersion: pending.fromVersion, at: pending.at, outcome };
      const history = [entry, ...this.state.history.filter((item) =>
        !(item.version === entry.version && item.fromVersion === entry.fromVersion && item.at === entry.at),
      )].slice(0, 30);
      await this.atomic("history.json", history);
      this.update({ history });
    });
    this.historyWrite = task;
    return task;
  }
  async markHealthy(): Promise<void> {
    let pending: PendingUpdate;
    const file = path.join(this.directory, "framework-pending.json");
    try { pending = JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!/^\d+\.\d+\.\d+$/.test(pending.version) ||
      !/^\d+\.\d+\.\d+$/.test(pending.fromVersion) ||
      typeof pending.at !== "string" || !Number.isFinite(Date.parse(pending.at)) ||
      typeof pending.executable !== "string") throw new Error("Invalid pending framework update");
    if (pending.executable !== this.request.executable) return;
    const installed = pending.version === this.request.currentVersion;
    await this.record(pending, installed ? "installed" : "failed");
    await fs.rm(file, { force: true });
    if (installed) this.update({ phase: "complete", message: "升级完成，Synax 已成功启动" });
  }
  private operation(action: () => Promise<void>): Promise<void> {
    if (this.active) return this.active;
    const task = action().catch((error) => this.fail(error)).finally(() => { this.active = null; });
    this.active = task;
    return task;
  }
  private async engine(): Promise<AppUpdater> {
    if (this.updater) return this.updater;
    const updater = await this.dependencies.create();
    updater.on("error", (error) => {
      this.fail(error);
      if (this.installing) void this.failInstallation().catch((failure) => this.fail(failure));
    });
    updater.on("download-progress", (progress) => {
      if (this.state.phase !== "downloading") return;
      this.update({
        progress: Math.max(0, Math.min(1, progress.percent / 100)),
        transfer: { mode: "full", downloadedBytes: progress.transferred, downloadSize: progress.total, reusedBytes: 0 },
      });
    });
    this.updater = updater;
    return updater;
  }
  check(): Promise<void> {
    if (["downloading", "verifying", "ready", "installing"].includes(this.state.phase)) return this.active ?? Promise.resolve();
    return this.operation(async () => {
      this.update({ phase: "checking", progress: 0, message: "正在检查更新…", transfer: undefined });
      await this.dependencies.eligible();
      const updater = await this.engine();
      await this.dependencies.configure(updater, getUpdateProxyUrl());
      const result = await updater.checkForUpdates();
      if (!result) throw new Error("自动更新不可用，请安装正式发布版。");
      this.info = result.isUpdateAvailable ? result.updateInfo : null;
      this.file = null;
      if (!this.info) {
        this.update({ phase: "current", availableVersion: null, size: 0, notes: "", message: "当前已是最新版本" });
        return;
      }
      const notes = typeof this.info.releaseNotes === "string" ? this.info.releaseNotes :
        this.info.releaseNotes?.map((item) => item.note).join("\n") ?? "";
      this.update({ phase: "available", availableVersion: this.info.version,
        size: this.info.files[0]?.size ?? 0, notes: notes.slice(0, 20_000), message: "发现新版本，可以下载" });
    });
  }
  download(): Promise<void> {
    if (!this.info || !["available", "error"].includes(this.state.phase)) return this.active ?? Promise.resolve();
    return this.operation(async () => {
      await this.dependencies.eligible();
      this.update({ phase: "downloading", progress: 0, message: "正在下载完整安装包…" });
      const files = await (await this.engine()).downloadUpdate();
      if (files.length !== 1) throw new Error("更新框架未返回有效安装包。");
      this.file = files[0];
      this.update({ phase: "verifying", progress: 1, message: "正在校验安装包…" });
      await this.verify();
      this.update({ phase: "ready", message: "安装包已下载并校验，可以重启安装" });
    });
  }
  private async verify(): Promise<void> {
    const item = this.info?.files[0];
    if (!this.file || !item) throw new Error("请先下载更新安装包。");
    const stat = await fs.lstat(this.file);
    const hash = createHash("sha512");
    if (!stat.isFile() || stat.size !== item.size) throw new Error("安装包校验失败，请重新下载。");
    for await (const bytes of createReadStream(this.file)) hash.update(bytes);
    if (hash.digest("base64") !== item.sha512) throw new Error("安装包校验失败，请重新下载。");
  }
  private async failInstallation(): Promise<void> {
    this.installing = false;
    const file = path.join(this.directory, "framework-pending.json");
    const pending: PendingUpdate = JSON.parse(await fs.readFile(file, "utf8"));
    await this.record(pending, "failed");
    await fs.rm(file, { force: true });
  }
  install(): Promise<void> {
    if (!this.info || !this.file || this.state.phase !== "ready") return this.active ?? Promise.resolve();
    return this.operation(async () => {
      await this.dependencies.eligible();
      this.update({ phase: "verifying", message: "正在重新校验安装包…" });
      await this.verify();
      await this.atomic("framework-pending.json", {
        version: this.info!.version, fromVersion: this.request.currentVersion,
        executable: this.request.executable, at: new Date().toISOString(),
      });
      this.installing = true;
      this.update({ phase: "installing", message: "正在重启并安装更新…" });
      try { await (await this.engine()).quitAndInstall(false, true); }
      catch (error) { await this.failInstallation(); throw error; }
    });
  }
}
