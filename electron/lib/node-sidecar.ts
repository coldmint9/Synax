import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import type { EventEmitter } from "node:events";
import { utilityProcess, app, type UtilityProcess } from "electron";
import path from "node:path";
import { createInterface } from "node:readline";
import { getDataRoot, getResourcePath } from "./data-paths.js";
import { resolveDesktopPath } from "./desktop-path.js";
import type { CuaRuntimeConnection } from "./cua-runtime.js";

const require = createRequire(import.meta.url);
let sidecar: UtilityProcess | ChildProcess | null = null;
let assignedPort = 0;
let starting: Promise<number> | null = null;
let cuaConnection: CuaRuntimeConnection | null = null;
export function setSidecarCuaConnection(connection: CuaRuntimeConnection | null): void {
  cuaConnection = connection;
  if (sidecar && assignedPort) sendCuaConnection(sidecar);
}
function sendCuaConnection(child: UtilityProcess | ChildProcess): void {
  const message = { type: 'synax:cua-connection', connection: cuaConnection
    ? { generation: cuaConnection.generation, ...cuaConnection.mcp } : null };
  if ('postMessage' in child && typeof child.postMessage === 'function') child.postMessage(message);
  else if ('send' in child && typeof child.send === 'function') child.send(message);
}


export function getSidecarPort(): number {
  return assignedPort;
}

export function startSidecar(): Promise<number> {
  if (starting) return starting;
  if (sidecar && assignedPort) return Promise.resolve(assignedPort);
  starting = launchSidecar().finally(() => {
    starting = null;
  });
  return starting;
}

async function launchSidecar(): Promise<number> {
  const env = {
    ...(process.env as Record<string, string>),
    PATH: await resolveDesktopPath(process.env.PATH),
    PORT: "0",
    SYNAX_DESKTOP_SIDECAR: "1",
    DATA_ROOT: getDataRoot(),
    NODE_ENV: app.isPackaged ? "production" : "development",
  };
  const child = app.isPackaged
    ? utilityProcess.fork(getResourcePath("server-dist", "server.cjs"), [], {
        cwd: process.resourcesPath,
        env,
        stdio: "pipe",
      })
    : spawn(
        process.execPath,
        [
          require.resolve("tsx/cli"),
          path.join(app.getAppPath(), "api", "server.ts"),
        ],
        {
          cwd: app.getAppPath(),
          env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
  sidecar = child;
  child.stdout?.on("data", (data: Buffer) => process.stdout.write(data));
  child.stderr?.on("data", (data: Buffer) => process.stderr.write(data));
  const events: EventEmitter = child;
  const lines = createInterface({ input: child.stdout! });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onError!: (error: Error) => void;
  let onExit!: (code: number) => void;
  events.once("exit", () => {
    if (sidecar === child) {
      sidecar = null;
      assignedPort = 0;
    }
  });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      onError = reject;
      onExit = (code) =>
        reject(new Error(`API sidecar exited with code ${code}`));
      events.once("error", onError);
      events.once("exit", onExit);
      timer = setTimeout(
        () => reject(new Error("API sidecar startup timed out")),
        30_000,
      );
      lines.on("line", (line) => {
        const match = /^SYNAX_DESKTOP_READY:(\d+)$/.exec(line);
        if (!match) return;
        const port = Number(match[1]);
        if (port > 0 && port <= 65535) resolve(port);
      });
    });
    assignedPort = port;
    sendCuaConnection(child);
    return port;
  } catch (error) {
    stopSidecar();
    throw error;
  } finally {
    clearTimeout(timer);
    lines.close();
    events.removeListener("error", onError);
    events.removeListener("exit", onExit);
  }
}

export function stopSidecar(): void {
  const child = sidecar;
  sidecar = null;
  assignedPort = 0;
  child?.kill();
}

/** Wait asynchronously for the sidecar to close MCP clients before stopping Cua. */
export async function stopSidecarGracefully(): Promise<void> {
  const child = sidecar;
  if (!child) return;
  setSidecarCuaConnection(null);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 3_000);
    timer.unref?.();
    (child as EventEmitter).once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
  stopSidecar();
}
