import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createWebGateway } from "../api/services/web/web-gateway.js";
import { ROOT_DIR, ensureBuiltServer, readPort, spawnProcess, waitForExit } from "./_shared.js";

const webPort = readPort("WEB_PORT", 5173);
const root = path.join(ROOT_DIR, "web", "dist");
if (!existsSync(path.join(root, "index.html"))) {
  const code = await waitForExit(spawnProcess(["npm", "run", "web:build"]));
  if (code) process.exit(code);
}
const certPath = process.env.WEB_TLS_CERT, keyPath = process.env.WEB_TLS_KEY;
if (Boolean(certPath) !== Boolean(keyPath)) throw new Error("Set both WEB_TLS_CERT and WEB_TLS_KEY, or neither.");
const tls = certPath && keyPath ? { cert: await readFile(certPath), key: await readFile(keyPath) } : undefined;
let child: ChildProcess | undefined;
let gateway: Awaited<ReturnType<typeof createWebGateway>> | undefined;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await gateway?.close();
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  process.exitCode = code;
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
try {
  let apiOrigin = process.env.SYNAX_API_ORIGIN;
  if (!apiOrigin) {
    await ensureBuiltServer();
    // Own an ephemeral port, and wait for readiness instead of racing a Vite UI.
    // This reuses the sidecar's existing readiness marker, not desktop APIs.
    child = spawn(process.execPath, [path.join(ROOT_DIR, "server-dist", "server.cjs")], {
      cwd: ROOT_DIR, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", WEB_PORT: String(webPort), NODE_ENV: "production", SYNAX_DESKTOP_SIDECAR: "1" },
    });
    child.stdout!.pipe(process.stdout); child.stderr!.pipe(process.stderr);
    const ownChild = child;
    apiOrigin = await new Promise<string>((resolve, reject) => {
      const lines = createInterface({ input: ownChild.stdout! });
      const cleanup = () => { clearTimeout(timer); lines.close(); ownChild.off("error", failed); ownChild.off("exit", exited); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const exited = (code: number | null) => failed(new Error(`Runtime exited before ready (${code}). Do not run two owners for the same DATA_ROOT.`));
      const timer = setTimeout(() => failed(new Error("Runtime startup timed out.")), 60_000);
      ownChild.once("error", failed); ownChild.once("exit", exited);
      lines.on("line", line => {
        const match = /^SYNAX_DESKTOP_READY:(\d+)$/.exec(line);
        if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) return;
        cleanup(); resolve(`http://127.0.0.1:${match[1]}`);
      });
    });
    ownChild.once("exit", code => { if (!stopping) void stop(code ?? 1); });
  }
  gateway = await createWebGateway({ root, apiOrigin, tls });
  const response = await fetch(`${apiOrigin}/api/health`, { signal: AbortSignal.timeout(5000) });
  const health = await response.json() as { ok?: boolean; service?: string; capabilities?: { realtime?: number } };
  if (!response.ok || health.service !== "api" || !health.ok || health.capabilities?.realtime !== 1)
    throw new Error("Runtime does not support this Web build. Rebuild/update the API with npm run build before starting Web.");
  if (stopping) { await gateway.close(); }
  else {
    await gateway.listen(webPort);
    console.log(`[start:web] ${tls ? "https" : "http"}://localhost:${webPort} (${gateway.protocol}; realtime WebSocket)`);
    if (!tls) console.log("[start:web] HTTP/2 requires WEB_TLS_CERT + WEB_TLS_KEY and a certificate trusted by your browser. HTTP/1.1 + shared WebSocket remains supported.");
  }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); await stop(1); }
