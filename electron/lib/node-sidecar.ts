import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import type { EventEmitter } from "node:events";
import { utilityProcess, app, type UtilityProcess } from "electron";
import path from "node:path";
import net from "node:net";
import { getDataRoot, getResourcePath } from "./data-paths.js";
import { resolveDesktopPath } from "./desktop-path.js";

const require = createRequire(import.meta.url);
let sidecar: UtilityProcess | ChildProcess | null = null;
let assignedPort = 3210;

export function getSidecarPort(): number {
  return assignedPort;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object")
        server.close(() => resolve(addr.port));
      else server.close(() => reject(new Error("Failed to get port")));
    });
    server.on("error", reject);
  });
}

export async function startSidecar(): Promise<number> {
  if (sidecar) return assignedPort;
  assignedPort = await findFreePort();
  const env = {
    ...(process.env as Record<string, string>),
    PATH: await resolveDesktopPath(process.env.PATH),
    PORT: String(assignedPort),
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
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
  sidecar = child;
  child.stdout?.on("data", (data: Buffer) => process.stdout.write(data));
  child.stderr?.on("data", (data: Buffer) => process.stderr.write(data));
  const events: EventEmitter = child;
  const exited = new Promise<never>((_, reject) => {
    events.once("error", reject);
    events.once("exit", (code) => {
      if (sidecar === child) sidecar = null;
      reject(new Error(`API sidecar exited with code ${code}`));
    });
  });
  try {
    await Promise.race([waitForHealth(assignedPort), exited]);
    return assignedPort;
  } catch (error) {
    stopSidecar();
    throw error;
  }
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (sidecar && Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return;
    } catch {
      /* The server may still be loading native modules and migrating its database. */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Sidecar failed to start on port ${port}`);
}

export function stopSidecar(): void {
  const child = sidecar;
  sidecar = null;
  child?.kill();
}
