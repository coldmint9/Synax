import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  downloadDesktopRelease,
  findDesktopRelease,
  verifyDesktopArtifact,
  hashFile,
  type DesktopRelease,
  type DesktopPlatform,
  type DesktopArch,
} from "../lib/desktop-update-feed.js";
import {
  checkMacInstallLocation,
  launchMacInstaller,
  prepareMacInstallation,
} from "../lib/mac-desktop-update.js";
import type {
  UpdaterRequest,
  UpdaterState,
  UpdateHistory,
} from "./contract.js";

const run = promisify(execFile);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export async function controlHost(
  request: UpdaterRequest,
  command: "quit" | "ui-check",
  manual = false,
): Promise<void> {
  const response = await fetch(new URL(command, request.controlUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${request.token}`,
      "X-Synax-Manual": manual ? "1" : "0",
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok)
    throw new Error("Synax 拒绝了升级器请求，请重新打开升级器。");
}
export interface ControllerDependencies {
  find: typeof findDesktopRelease;
  download: typeof downloadDesktopRelease;
  verify: typeof verifyDesktopArtifact;
  install: (
    request: UpdaterRequest,
    release: DesktopRelease,
    file: string,
    directory: string,
    status: (message: string) => void,
  ) => Promise<void>;
}

export async function installDesktop(
  request: UpdaterRequest,
  release: DesktopRelease,
  file: string,
  directory: string,
  status: (message: string) => void,
): Promise<void> {
  if (!(await verifyDesktopArtifact(file, release.manifest.artifact)))
    throw new Error("安装包校验失败，请重新下载。");
  const root = path.dirname(directory);
  let marker: string;
  if (release.manifest.platform === "darwin") {
    status("正在准备新版本，Synax 暂时仍可使用…");
    const installation = await prepareMacInstallation(
      file,
      release.manifest,
      request.executable,
      directory,
    );
    // Confirm the host can accept the request before starting the helper. If the
    // user already quit Synax, the independent updater can continue on its own.
    if (processRunning(request.parentPid)) await controlHost(request, "quit");
    await launchMacInstaller(installation, root, request.parentPid, [
      "--user-data-dir=" + request.profile,
    ]);
    marker = path.join(root, "pending-install.json");
  } else {
    const updateExe = path.resolve(request.executable, "../../Update.exe");
    await fs.access(updateExe);
    await fs.writeFile(
      path.join(directory, "RELEASES"),
      `${await hashFile(file, "sha1")} ${path.basename(file)} ${(await fs.stat(file)).size}\n`,
    );
    if (processRunning(request.parentPid)) await controlHost(request, "quit");
    const deadline = Date.now() + 120_000;
    while (processRunning(request.parentPid)) {
      if (Date.now() > deadline)
        throw new Error("Synax 尚未退出，未进行安装。请关闭 Synax 后重试。");
      await delay(250);
    }
    status("正在安装新版本…");
    marker = path.join(root, "pending-windows.json");
    await fs.writeFile(
      marker,
      JSON.stringify({
        version: release.manifest.version,
        installRoot: path.resolve(request.executable, "../.."),
      }),
    );
    // Target the host's Squirrel installation, never the updater's own runtime.
    await run(updateExe, ["--update", directory], {
      timeout: 15 * 60_000,
      windowsHide: true,
    });
    const child = spawn(
      updateExe,
      [
        "--processStart",
        path.basename(request.executable),
        "--process-start-args",
        `--user-data-dir="${request.profile}"`,
      ],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  }
  status("正在等待 Synax 完成升级并启动…");
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      await fs.access(marker);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await delay(500);
  }
  throw new Error(
    "尚未收到新版本启动成功的确认。升级记录和旧版本已保留，请查看 updater.log 后重试打开 Synax。",
  );
}

const defaults: ControllerDependencies = {
  find: findDesktopRelease,
  download: downloadDesktopRelease,
  verify: verifyDesktopArtifact,
  install: installDesktop,
};
export class UpdaterController {
  private release: DesktopRelease | null = null;
  private file: string | null = null;
  private busy = false;
  readonly state: UpdaterState;
  constructor(
    readonly request: UpdaterRequest,
    private readonly changed: (state: UpdaterState) => void,
    private readonly dependencies = defaults,
  ) {
    this.state = {
      phase: "idle",
      currentVersion: request.currentVersion,
      uiVersion: request.uiVersion,
      availableVersion: null,
      size: 0,
      progress: 0,
      notes: "",
      message: "准备检查更新",
      history: [],
    };
  }
  get locked(): boolean {
    return this.busy;
  }
  get directory(): string {
    return path.join(this.request.profile, "desktop-updates");
  }
  snapshot(): UpdaterState {
    return structuredClone(this.state);
  }
  private update(patch: Partial<UpdaterState>): void {
    Object.assign(this.state, patch);
    this.changed(this.snapshot());
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const entries = JSON.parse(
        await fs.readFile(path.join(this.directory, "history.json"), "utf8"),
      );
      if (Array.isArray(entries))
        this.state.history = entries
          .filter(
            (entry): entry is UpdateHistory =>
              entry &&
              /^\d+\.\d+\.\d+$/.test(entry.version) &&
              typeof entry.fromVersion === "string" &&
              typeof entry.at === "string" &&
              ["installed", "failed"].includes(entry.outcome),
          )
          .slice(0, 30);
    } catch {
      /* First run or a damaged history must not prevent updating. */
    }
    this.changed(this.snapshot());
  }
  private async record(outcome: UpdateHistory["outcome"]): Promise<void> {
    const entries = [
      {
        version: this.release!.manifest.version,
        fromVersion: this.request.currentVersion,
        at: new Date().toISOString(),
        outcome,
      },
      ...this.state.history,
    ].slice(0, 30);
    const destination = path.join(this.directory, "history.json");
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(entries), { mode: 0o600 });
    await fs.rename(temporary, destination);
    this.update({ history: entries });
  }
  private async operation(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await action();
    } catch (error) {
      console.error("[updater]", error);
      this.update({
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.busy = false;
      this.changed(this.snapshot());
    }
  }
  async check(): Promise<void> {
    await this.operation(async () => {
      this.update({
        phase: "checking",
        message: "正在检查可用版本…",
        progress: 0,
      });
      this.release = await this.dependencies.find(
        this.state.currentVersion,
        process.platform as DesktopPlatform,
        process.arch as DesktopArch,
      );
      this.file = null;
      if (!this.release) {
        this.update({
          phase: "current",
          availableVersion: null,
          size: 0,
          notes: "",
          message: "当前软件已是最新版本",
        });
        return;
      }
      const { manifest } = this.release;
      const directory = path.join(
        this.directory,
        `${manifest.version}-${manifest.platform}-${manifest.arch}`,
      );
      const candidate = path.join(directory, manifest.artifact.name);
      if (await this.dependencies.verify(candidate, manifest.artifact))
        this.file = candidate;
      this.update({
        phase: this.file ? "ready" : "available",
        availableVersion: manifest.version,
        size: manifest.artifact.size,
        notes:
          this.release.notes || "此版本包含 Synax 内核、后台服务和界面更新。",
        message: this.file ? "安装包已校验，可以安装" : "发现可用的新版本",
      });
    });
  }
  async download(): Promise<void> {
    if (!this.release || !["available", "error"].includes(this.state.phase))
      return;
    await this.operation(async () => {
      if (process.platform === "darwin")
        await checkMacInstallLocation(this.request.executable);
      else
        await fs.access(
          path.resolve(this.request.executable, "../../Update.exe"),
        );
      const { manifest } = this.release!;
      this.update({
        phase: "downloading",
        message: "正在下载并校验安装包…",
        progress: 0,
      });
      this.file = await this.dependencies.download(
        this.release!,
        path.join(
          this.directory,
          `${manifest.version}-${manifest.platform}-${manifest.arch}`,
        ),
        (progress) => this.update({ progress }),
      );
      this.update({
        phase: "ready",
        progress: 1,
        message: "下载完成，安装包已校验",
      });
    });
  }
  async install(): Promise<void> {
    if (!this.release || !this.file || this.state.phase !== "ready") return;
    await this.operation(async () => {
      this.update({ phase: "installing", message: "正在准备安装…" });
      try {
        await this.dependencies.install(
          this.request,
          this.release!,
          this.file!,
          path.dirname(this.file!),
          (message) => this.update({ message }),
        );
      } catch (error) {
        await this.record("failed");
        throw error;
      }
      await this.record("installed");
      this.update({
        phase: "complete",
        currentVersion: this.release!.manifest.version,
        uiVersion: null,
        message: "升级完成，Synax 已重新启动",
      });
    });
  }
}
