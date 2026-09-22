/** Real production Web transcript + API. Disposable data; no provider calls. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright-core";
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "synax-prototype-web-"));
const output = path.resolve("out/prototype-web-acceptance");
await fs.mkdir(output, { recursive: true });
process.env.DATA_ROOT = path.join(temp, "data");
process.env.LOG_LEVEL = "error";
await fs.mkdir(process.env.DATA_ROOT, { recursive: true });
const workspace = path.join(temp, "workspace");
await fs.mkdir(workspace);
const source =
  '<html><body><button id="counter">Count 0</button><script>let n=0;document.querySelector("button").onclick=()=>document.querySelector("button").textContent="Count "+(++n);</script></body></html>';
await fs.writeFile(path.join(workspace, "demo.html"), source);
await fs.writeFile(
  path.join(process.env.DATA_ROOT, "projects.json"),
  JSON.stringify({
    items: [
      {
        id: "artifact-app",
        name: "Artifact acceptance",
        status: "healthy",
        environment: "development",
        healthScore: 100,
        activeAgents: 0,
        activeHumans: 1,
        openRisks: 0,
        updatedAt: new Date().toISOString(),
        source: { kind: "localPath", localPath: workspace },
      },
    ],
  }),
);
const { agentSessionRuntime } =
  await import("../api/services/agent-runtime/session-runtime.js");
const { agentRuntimeStore } =
  await import("../api/services/agent-runtime/session-store.js");
const { compileCompletedPrototypes } =
  await import("../api/services/agent-runtime/prototype-integration.js");
const { closeDb } = await import("../api/db/index.js");
const session = agentSessionRuntime.create({
  projectId: "artifact-app",
  profileId: "executor",
  prompt: "Synthetic artifact desktop acceptance",
  workDir: workspace,
});
agentRuntimeStore.updateSession(session.id, { status: "completed" });
const message = agentRuntimeStore.appendMessage({
  id: "prototype-desktop-message",
  sessionId: session.id,
  runId: null,
  stepId: null,
  role: "assistant",
  content:
    "```synax-prototype\n" +
    JSON.stringify({
      sourcePath: "demo.html",
      title: "Runtime desktop QA",
      sourceKind: "html",
    }) +
    "\n```",
  metadata: {},
  createdAt: new Date().toISOString(),
});
await compileCompletedPrototypes(message);
await fs.unlink(path.join(workspace, "demo.html")); // Persisted preview must not re-read source.
closeDb();

async function freePort() {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
const apiPort = await freePort();
const webPort = await freePort();
const logs: string[] = [];
const api = spawn(process.execPath, ["server-dist/server.cjs"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(apiPort), WEB_PORT: String(webPort) },
  stdio: ["ignore", "pipe", "pipe"],
});
api.stdout.on("data", (data) => logs.push(data.toString()));
api.stderr.on("data", (data) => logs.push(data.toString()));
const dist = path.resolve("web/dist");
const server = http.createServer(async (req, res) => {
  if (req.url?.startsWith("/api/")) {
    const proxied = http.request(
      {
        hostname: "127.0.0.1",
        port: apiPort,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${apiPort}` },
      },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(res);
      },
    );
    proxied.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(proxied);
    return;
  }
  try {
    const pathname = new URL(req.url || "/", "http://local").pathname;
    let file = path.resolve(dist, "." + pathname);
    if (!file.startsWith(dist + path.sep)) file = path.join(dist, "index.html");
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(file);
    } catch {
      file = path.join(dist, "index.html");
      bytes = await fs.readFile(file);
    }
    const type =
      (
        {
          ".js": "application/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".woff2": "font/woff2",
        } as Record<string, string>
      )[path.extname(file)] || "text/html";
    res.writeHead(200, { "Content-Type": type });
    res.end(bytes);
  } catch {
    res.writeHead(500);
    res.end();
  }
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(`http://127.0.0.1:${apiPort}/api/health`)).ok) break;
    } catch {}
    if (attempt >= 100 || api.exitCode !== null)
      throw new Error("Isolated API failed to start");
    await new Promise((r) => setTimeout(r, 100));
  }
  server.listen(webPort, "127.0.0.1");
  await once(server, "listening");
  browser = await chromium.launch({
    executablePath:
      process.env.SYNAX_CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1200, height: 900 },
  });
  page.on("pageerror", (e) => logs.push("PAGE ERROR: " + e.message));
  page.on("response", (r) => {
    if (r.status() >= 400) logs.push("HTTP " + r.status() + " " + r.url());
  });
  await page.goto(
    `http://127.0.0.1:${webPort}/projects/artifact-app/sessions?session=${session.id}`,
  );
  const card = page.locator(".prototype-card");
  await card.waitFor({ timeout: 30000 });
  const frame = card.frameLocator("iframe");
  await frame.getByRole("button", { name: "Count 0" }).click();
  await frame.getByRole("button", { name: "Count 1" }).waitFor();
  assert.equal(await card.locator('button,select,[role="tab"]').count(), 0);
  await card.locator(".prototype-card-header").hover();
  await page.waitForFunction(()=>getComputedStyle(document.querySelector(".prototype-card-title")!).opacity==="1");
  await page.screenshot({ path: path.join(output, "conversation.png") });
  await page.reload();
  await frame.getByRole("button", { name: "Count 0" }).waitFor();
  await fs.writeFile(
    path.join(output, "acceptance.json"),
    JSON.stringify(
      {
        passed: true,
        checks: [
          "real conversation displays compiled message after source deletion",
          "prototype interaction works without management UI",
          "reload preserves message content and resets prototype interaction",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS real production Web conversation, source-independent preview, click and reload/reset",
  );
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({ path: path.join(output, "failure.png") });
    await fs.writeFile(
      path.join(output, "failure.txt"),
      await page.locator("body").innerText(),
    );
  }
  throw error;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  api.kill("SIGTERM");
  await Promise.race([
    once(api, "exit"),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  if (api.exitCode === null) api.kill("SIGKILL");
  await fs.writeFile(path.join(output, "server.log"), logs.join(""));
  await fs.rm(temp, { recursive: true, force: true });
}
