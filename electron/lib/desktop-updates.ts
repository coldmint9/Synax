import { app, dialog, type BrowserWindow } from "electron";
import { promises as fs, createReadStream } from "original-fs";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { getResourcePath } from "./data-paths.js";
import { finishMacInstallation } from "./mac-desktop-update.js";
import type { UpdaterRequest } from "../updater/contract.js";
import { updaterExecutable } from "../updater/paths.js";

// The host only launches the embedded app and handles its authenticated quit
// request. All version checks, downloads and installation run in that app.
export class DesktopUpdates {
  private child: ChildProcess | null = null;
  private server: Server | null = null;
  private requestFile: string | null = null;
  private opening: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly checkUi: (manual: boolean) => Promise<void>,
    private readonly uiVersion: () => string | null,
  ) {}

  start(_window: BrowserWindow): void {
    if (this.timer) return;
    this.startTimer = setTimeout(() => void this.check(false), 30_000);
    this.timer = setInterval(() => void this.check(false), 12 * 60 * 60_000);
    this.startTimer.unref();
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.startTimer) clearTimeout(this.startTimer);
    this.timer = this.startTimer = null;
    this.server?.close();
    this.server = null;
    // Do not terminate the updater: it must survive the host application.
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

  check(manual: boolean): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = this.open(manual)
      .catch(async (error) => {
        console.error("[updater] failed to open", error);
        if (manual)
          await dialog.showMessageBox({
            type: "error",
            title: "无法打开升级器",
            message: "内置升级器启动失败。",
            detail: String(error),
            buttons: ["确定"],
          });
      })
      .finally(() => {
        this.opening = null;
      });
    return this.opening;
  }

  private async open(manual: boolean): Promise<void> {
    if (this.child && this.requestFile) {
      if (manual) await fs.writeFile(`${this.requestFile}.show`, "show");
      return;
    }
    const profile = app.getPath("userData");
    const embedded = getResourcePath("updater");
    const asar = path.join(
      embedded,
      process.platform === "darwin"
        ? "Synax Updater.app/Contents/Resources/app.asar"
        : "resources/app.asar",
    );
    // Treat app.asar as an opaque file when hashing and copying the runtime.
    // Electron's patched fs would otherwise interpret it as an archive directory.
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(asar)) hash.update(chunk);
    const revision = hash.digest("hex").slice(0, 16);
    const runtime = path.join(
      profile,
      "updater-runtime",
      `${app.getVersion()}-${revision}`,
    );
    try {
      await fs.access(path.join(runtime, ".ready"));
    } catch {
      const staging = `${runtime}.${randomUUID()}.tmp`;
      await fs.mkdir(path.dirname(runtime), { recursive: true, mode: 0o700 });
      try {
        await fs.cp(embedded, staging, {
          recursive: true,
          verbatimSymlinks: true,
        });
        await fs.writeFile(path.join(staging, ".ready"), revision);
        await fs.rm(runtime, { recursive: true, force: true });
        await fs.rename(staging, runtime);
      } finally {
        await fs.rm(staging, { recursive: true, force: true });
      }
    }
    const token = randomBytes(32).toString("hex");
    const server = createServer((request, response) => {
      if (
        request.method !== "POST" ||
        request.headers.authorization !== `Bearer ${token}`
      ) {
        response.writeHead(403).end();
        return;
      }
      if (request.url === "/quit") {
        response.end("ok");
        setTimeout(() => app.quit(), 100);
        return;
      }
      if (request.url === "/ui-check") {
        response.end("ok");
        void this.checkUi(request.headers["x-synax-manual"] === "1").catch(
          (error) => console.error("[ui-update]", error),
        );
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    this.server = server;
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Updater control server unavailable");
    const directory = path.join(profile, "updater-sessions");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const requestFile = path.join(directory, `${randomUUID()}.json`);
    this.requestFile = requestFile;
    const request: UpdaterRequest = {
      format: 1,
      currentVersion: app.getVersion(),
      uiVersion: this.uiVersion(),
      executable: process.execPath,
      profile,
      parentPid: process.pid,
      controlUrl: `http://127.0.0.1:${address.port}/`,
      token,
      background: !manual,
    };
    await fs.writeFile(requestFile, JSON.stringify(request), { mode: 0o600 });
    const log = await fs.open(path.join(profile, "updater.log"), "a", 0o600);
    try {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      const child = spawn(
        updaterExecutable(runtime),
        [`--request=${requestFile}`],
        {
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
          cwd: runtime,
          env,
        },
      );
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      this.child = child;
      child.once("exit", () => {
        this.child = null;
        this.requestFile = null;
        server.close();
        if (this.server === server) this.server = null;
        void fs.rm(requestFile, { force: true });
        void fs.rm(`${requestFile}.show`, { force: true });
      });
      child.unref();
    } catch (error) {
      server.close();
      this.server = null;
      throw error;
    } finally {
      await log.close();
    }
  }
}
