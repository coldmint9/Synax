import { fork, type ChildProcess } from "node:child_process";
import net from "node:net";
import { runtimeAsset } from "./runtime-paths.js";
import { DATA_ROOT } from "./env.js";
import { logger } from "./logger.js";

const STARTUP_TIMEOUT_MS = 10_000;

let child: ChildProcess | undefined;
let origin: string | undefined;

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function logChildOutput(stream: NodeJS.ReadableStream | null | undefined, level: "debug" | "warn"): void {
  stream?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (!text) return;
    logger[level]({ output: text }, "[read-service]");
  });
}

/**
 * Starts the isolated read API. The read service deliberately owns its own
 * event loop: a synchronous SQLite read there cannot delay command handling
 * or session control in the primary runtime process.
 */
export async function startReadService(): Promise<void> {
  if (child || process.env.SYNAX_DISABLE_READ_SERVICE === "1") return;

  const port = await reserveLoopbackPort();
  const entry = runtimeAsset(
    // Bundles replace import.meta.url with undefined and resolve the CJS asset
    // beside server.cjs. Source runs use the TypeScript entry directly.
    import.meta.url,
    "../../entrypoints/read-server.ts",
    "read-server.cjs",
  );
  const isSource = entry.endsWith(".ts");
  const started = new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Read service startup timed out."));
    }, STARTUP_TIMEOUT_MS);
    timer.unref();

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
      SYNAX_READ_SERVICE: "1",
      SYNAX_DISABLE_READ_SERVICE: "1",
      DATA_ROOT,
    };
    delete childEnv.SYNAX_RUNTIME_HOST_ID;
    delete childEnv.SYNAX_RUNTIME_DATA_ROOT;

    const processChild = fork(entry, [], {
      env: childEnv,
      execArgv: isSource ? ["--import", "tsx/esm"] : [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child = processChild;
    logChildOutput(processChild.stdout, "debug");
    logChildOutput(processChild.stderr, "warn");

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    processChild.once("error", finish);
    processChild.once("exit", (code, signal) => {
      if (!settled) finish(new Error(`Read service exited during startup (${code ?? signal ?? "unknown"}).`));
      if (child === processChild) {
        child = undefined;
        origin = undefined;
      }
    });
    processChild.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "ready") return;
      if ((message as { port?: unknown }).port !== port) {
        finish(new Error("Read service reported an unexpected port."));
        return;
      }
      origin = `http://127.0.0.1:${port}`;
      finish();
    });
  });

  try {
    await started;
    logger.info({ origin }, "Read service started");
  } catch (error) {
    logger.warn({ error }, "Read service unavailable; primary API will serve reads");
    await stopReadService();
  }
}

export function readServiceOrigin(): string | undefined {
  return origin;
}

export async function stopReadService(): Promise<void> {
  const processChild = child;
  child = undefined;
  origin = undefined;
  if (!processChild || processChild.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (processChild.exitCode === null) processChild.kill("SIGKILL");
      resolve();
    }, 3_000);
    timer.unref();
    processChild.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    processChild.kill("SIGTERM");
  });
}
