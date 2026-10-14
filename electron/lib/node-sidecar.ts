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
let recoveryPort = 0;
let wanted = false;
let generation = 0;
let failures = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
const RETRY_DELAYS = [1_000, 2_000, 4_000];

function scheduleRecovery(): void {
  if (!wanted || retryTimer || failures >= RETRY_DELAYS.length) return;
  const expected = generation;
  const delay = RETRY_DELAYS[failures++];
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    if (!wanted || generation !== expected) return;
    void startSidecar().catch(error => {
      console.error("[sidecar] recovery failed", error);
      if (generation === expected) scheduleRecovery();
    });
  }, delay);
  retryTimer.unref?.();
}
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
  wanted = true;
  if (starting) return starting;
  if (sidecar && assignedPort) return Promise.resolve(assignedPort);
  const attempt = launchSidecar(generation).finally(() => {
    if (starting === attempt) starting = null;
  });
  starting = attempt;
  return starting;
}

async function launchSidecar(expectedGeneration: number): Promise<number> {
  const env = {
    ...(process.env as Record<string, string>),
    PATH: await resolveDesktopPath(process.env.PATH),
    PORT: String(recoveryPort),
    SYNAX_DESKTOP_SIDECAR: "1",
    DATA_ROOT: getDataRoot(),
    NODE_ENV: app.isPackaged ? "production" : "development",
  };
  if (!wanted || generation !== expectedGeneration) throw new Error("Sidecar startup cancelled");
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
          path.join(app.getAppPath(), "services", "local-node", "entrypoints", "http-server.ts"),
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
  let readyAt = 0;
  events.on("error", error => console.error("[sidecar] process error", error));
  events.once("exit", (code) => {
    if (sidecar !== child) return;
    sidecar = null;
    assignedPort = 0;
    if (readyAt && wanted && generation === expectedGeneration) {
      // A healthy minute resets the crash budget; a crash loop never does.
      if (Date.now() - readyAt >= 60_000) failures = 0;
      console.error(`[sidecar] exited unexpectedly (${code}); recovery attempt ${failures + 1}`);
      scheduleRecovery();
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
    if (!wanted || generation !== expectedGeneration || sidecar !== child)
      throw new Error("Sidecar startup cancelled");
    if (recoveryPort && port !== recoveryPort) throw new Error("Sidecar recovery changed the API port");
    assignedPort = recoveryPort = port;
    readyAt = Date.now() || 1;
    sendCuaConnection(child);
    return port;
  } catch (error) {
    if (sidecar === child) { sidecar = null; assignedPort = 0; }
    child.kill();
    throw error;
  } finally {
    clearTimeout(timer);
    lines.close();
    // readline.close() pauses its input. Keep draining logs after readiness so
    // a full stdout pipe cannot block the backend (including exit-time flushes).
    child.stdout?.resume();
    events.removeListener("error", onError);
    events.removeListener("exit", onExit);
  }
}

export function stopSidecar(): void {
  wanted = false;
  generation++;
  clearTimeout(retryTimer); retryTimer = undefined;
  recoveryPort = 0; failures = 0;
  const child = sidecar;
  sidecar = null;
  assignedPort = 0;
  child?.kill();
}

/** Wait asynchronously for the sidecar to close MCP clients before stopping Cua. */
export async function stopSidecarGracefully(): Promise<void> {
  wanted = false;
  clearTimeout(retryTimer); retryTimer = undefined;
  const child = sidecar;
  if (!child) return;
  setSidecarCuaConnection(null);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      // Sending SIGTERM again cannot terminate a stuck native/IPC call.
      if (sidecar === child && child.pid) {
        try { process.kill(child.pid, "SIGKILL"); } catch { /* already exited */ }
      }
      resolve();
    }, 6_000);
    timer.unref?.();
    (child as EventEmitter).once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
  stopSidecar();
}
