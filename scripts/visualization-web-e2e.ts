/** Real production Web transcript + API. Disposable data; no provider calls. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright-core";
const temp = await fs.mkdtemp(
  path.join(os.tmpdir(), "synax-visualization-web-"),
);
const output = path.resolve("out/visualization-web-acceptance");
await fs.mkdir(output, { recursive: true });
process.env.DATA_ROOT = path.join(temp, "data");
process.env.LOG_LEVEL = "error";
await fs.mkdir(process.env.DATA_ROOT, { recursive: true });
const workspace = path.join(temp, "workspace");
await fs.mkdir(workspace);
const source = await fs.readFile(
  path.resolve(
    "web/src/react/features/visualizations/__tests__/fixtures/approved-demo.html",
  ),
  "utf8",
);
await fs.writeFile(
  path.join(process.env.DATA_ROOT, "projects.json"),
  JSON.stringify({
    items: [
      {
        id: "visualization-app",
        name: "Inline visualization acceptance",
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
const { persistInlineVisualization } =
  await import("../api/services/agent-runtime/visualization-integration.js");
const { closeDb } = await import("../api/db/index.js");
const session = agentSessionRuntime.create({
  projectId: "visualization-app",
  profileId: "executor",
  prompt: "确认这份交互原型的样式与行为",
  workDir: workspace,
});
agentRuntimeStore.updateSession(session.id, { status: "completed" });
const message = agentRuntimeStore.appendMessage({
  id: "visualization-message",
  sessionId: session.id,
  runId: null,
  stepId: null,
  role: "assistant",
  content:
    "这是对话内联预览。\n```synax-visualize\n" +
    source +
    "\n```\n确认后再继续调整。",
  metadata: {},
  createdAt: new Date().toISOString(),
});
persistInlineVisualization(message);
assert.ok(message.metadata.visualization);
assert.deepEqual(await fs.readdir(workspace), []);

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
let escapedRequests = 0;
const api = spawn(process.execPath, ["server-dist/server.cjs"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(apiPort), WEB_PORT: String(webPort) },
  stdio: ["ignore", "pipe", "pipe"],
});
api.stdout.on("data", (data) => logs.push(data.toString()));
api.stderr.on("data", (data) => logs.push(data.toString()));
const dist = path.resolve("web/dist");
const server = http.createServer(async (req, res) => {
  if (req.url?.startsWith("/escape")) {
    escapedRequests++;
    res.writeHead(200);
    res.end("Unexpected navigation");
    return;
  }
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
let page: import("playwright-core").Page | undefined;
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
  page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on("pageerror", (e) => logs.push("PAGE ERROR: " + e.message));
  page.on("response", (r) => {
    if (r.status() >= 400) logs.push("HTTP " + r.status() + " " + r.url());
  });
  await page.goto(
    `http://127.0.0.1:${webPort}/projects/visualization-app/sessions?session=${session.id}`,
  );
  const card = page.locator(".inline-visualization");
  await card.waitFor({ timeout: 30000 });
  const frame = card.frameLocator("iframe");
  await frame.getByRole("button", { name: "Explore workspace" }).click();
  await frame
    .locator("[data-progress-value]")
    .filter({ hasText: "78%" })
    .waitFor();
  await frame.getByRole("button", { name: "Add a note" }).click();
  await frame
    .locator("[data-activity-list]")
    .getByText("A note was added to the prototype")
    .waitFor();
  await frame.getByRole("tab", { name: "Overview" }).click();
  assert.equal(await card.locator('button,select,[role="tab"]').count(), 0);
  assert.equal(await page.locator(".prototype-card,.artifact-card").count(), 0);
  assert.ok(await frame.locator('svg[data-lucide-icon="sparkles"]').count());
  await page.getByText("这是对话内联预览。", { exact: true }).waitFor();
  await page.getByText("确认后再继续调整。", { exact: true }).waitFor();
  const iframe = await card.locator("iframe").elementHandle();
  const inner = (await iframe!.contentFrame())!;
  assert.equal(
    await inner.evaluate(() => typeof (window as any).electronAPI),
    "undefined",
  );
  assert.equal(
    await inner.evaluate(() => typeof (window as any).require),
    "undefined",
  );
  assert.equal(
    await inner.evaluate(() => {
      try {
        return !!parent.document;
      } catch {
        return false;
      }
    }),
    false,
  );
  const escape = `http://127.0.0.1:${webPort}/escape`;
  assert.equal(
    await inner.evaluate(async (url) => {
      try {
        await fetch(url);
        return true;
      } catch {
        return false;
      }
    }, escape),
    false,
  );
  await card.evaluate((node) => {
    (node as HTMLElement).style.maxWidth = "736px";
  });
  await page.evaluate(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.dataset.theme = "light";
  });
  await inner.waitForFunction(
    () => document.documentElement.dataset.theme === "light",
  );
  await card.screenshot({ path: path.join(output, "preview-light.png") });
  await page.screenshot({ path: path.join(output, "conversation.png") });
  await page.evaluate(() => {
    document.documentElement.classList.add("dark");
    document.documentElement.dataset.theme = "dark";
  });
  await inner.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await card.screenshot({ path: path.join(output, "preview-dark.png") });
  await card.evaluate((node) => {
    (node as HTMLElement).style.width = "320px";
  });
  await page.waitForTimeout(100);
  assert.ok(
    await inner.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth + 1,
    ),
  );
  await card.screenshot({ path: path.join(output, "preview-320.png") });
  // Parent frame-src policy must also prevent a generated script navigating its own iframe.
  await inner.evaluate((url) => {
    location.href = url;
  }, escape);
  await page.waitForTimeout(150);
  assert.equal(escapedRequests, 0);
  await card.getByRole("alert").waitFor();
  await page.reload();
  await frame
    .locator("[data-progress-value]")
    .filter({ hasText: "72%" })
    .waitFor();
  assert.equal(
    await frame.getByText("A note was added to the prototype").count(),
    0,
  );
  assert.equal((await fs.readdir(workspace)).length, 0);
  await fs.writeFile(
    path.join(output, "acceptance.json"),
    JSON.stringify(
      {
        passed: true,
        platform: "Chromium",
        checks: [
          "production API + Web transcript renders saved inline metadata without workspace files",
          "approved design styles and bundled Lucide icons render; buttons and tabs work",
          "reply ordering, no outer artifact UI, light/dark, automatic height and 320px layout",
          "opaque sandbox blocks parent DOM, Node, fetch and self navigation before network",
          "reload preserves fragment and resets local interactions",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS production Web inline visualization: design, interaction, themes, layout, isolation and reload",
  );
} catch (error) {
  logs.push(String(error));
  if (page && !page.isClosed()) {
    await page
      .screenshot({ path: path.join(output, "failure.png") })
      .catch(() => {});
    await fs.writeFile(
      path.join(output, "failure.txt"),
      await page
        .locator("body")
        .innerText()
        .catch(() => "Page closed"),
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
