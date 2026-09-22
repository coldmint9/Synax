/** Packaged Synax + real sidecar + production preload/transport/transcript.
 * Uses a disposable DATA_ROOT and synthetic source; never invokes a provider. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  _electron,
  type ElectronApplication,
  type Page,
} from "playwright-core";
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "synax-artifact-app-"));
const output = path.resolve("out/artifact-acceptance");
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
const exe =
  process.argv[2] ??
  path.resolve(
    `out/Synax-${process.platform}-${process.arch}/${process.platform === "darwin" ? "Synax.app/Contents/MacOS/Synax" : process.platform === "win32" ? "Synax.exe" : "Synax"}`,
  );
const env = { ...process.env } as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_SKIP_SIDECAR;
delete env.NODE_OPTIONS;
let app: ElectronApplication | undefined, page: Page | undefined;
let logs = "";
const checks: string[] = [];
const check = (name: string) => {
  checks.push(name);
  console.log("PASS", name);
};
try {
  app = await _electron.launch({
    executablePath: exe,
    args: [`--user-data-dir=${path.join(temp, "profile")}`],
    env,
    timeout: 60000,
  });
  app.process().stdout?.on("data", (data) => {
    logs += data;
  });
  app.process().stderr?.on("data", (data) => {
    logs += data;
  });
  page = await app.firstWindow({ timeout: 60000 });
  page.setDefaultTimeout(15000);
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(1200, 900);
    w.show();
    w.focus();
  });
  // Let the packaged main finish its initial load before navigating; racing
  // bootstrap.loadURL triggers ERR_ABORTED and legitimately closes the app.
  await page.locator(".wh-project-trigger").waitFor({ timeout: 60000 });
  await page.goto(
    `app://./projects/artifact-app/sessions?session=${session.id}`,
  );
  const card = page.locator(".prototype-card");
  await card.locator('[data-live="true"]').waitFor();
  assert.equal(await card.locator('button,select,[role="tab"]').count(), 0);
  check(
    "real packaged prototype renders automatically from message metadata without source file",
  );
  const contents = await app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((w) => w.getURL().startsWith("synax-artifact:"))
      .map((w) => w.id),
  );
  assert.equal(contents.length, 1);
  const click = () =>
    app!.evaluate(
      ({ webContents }, id) =>
        webContents
          .fromId(id)!
          .executeJavaScript(
            'document.querySelector("button").click();document.querySelector("button").textContent',
          ),
      contents[0],
    );
  assert.equal(await click(), "Count 1");
  check("isolated generated button is interactive");
  await card.locator(".prototype-card-header").hover();
  await page.waitForFunction(()=>getComputedStyle(document.querySelector(".prototype-card-title")!).opacity==="1");
  await page.screenshot({ path: path.join(output, "packaged-prototype.png") });
  await page.reload();
  await card.locator('[data-live="true"]').waitFor();
  const text = await app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .find((w) => w.getURL().startsWith("synax-artifact:"))!
      .executeJavaScript('document.querySelector("button").textContent'),
  );
  assert.equal(text, "Count 0");
  check("reload restores compiled message and resets interaction state");
  await fs.writeFile(
    path.join(output, "packaged-acceptance.json"),
    JSON.stringify(
      { platform: process.platform, checks, passed: true },
      null,
      2,
    ),
  );
} catch (error) {
  if (page) {
    await page
      .screenshot({ path: path.join(output, "packaged-failure.png") })
      .catch(() => {});
    const geometry = await page
      .evaluate(() => {
        const el = document.querySelector(".artifact-preview-container");
        const ancestors = [];
        for (let p = el; p; p = p.parentElement) {
          const b = p.getBoundingClientRect();
          const c = getComputedStyle(p);
          ancestors.push({
            class: p.className,
            rect: { x: b.x, y: b.y, width: b.width, height: b.height },
            overflow: c.overflow,
            position: c.position,
            visibility: c.visibility,
            display: c.display,
            contentVisibility: c.contentVisibility,
          });
        }
        return {
          ancestors,
          overlays: [
            ...document.querySelectorAll(
              '[aria-modal="true"], [role="dialog"], [role="menu"], [role="listbox"], [data-artifact-overlay="true"], [data-slot="popover-content"]',
            ),
          ].map((e) => ({
            tag: e.tagName,
            class: e.className,
            display: getComputedStyle(e).display,
          })),
          hidden: document.hidden,
        };
      })
      .catch((e) => String(e));
    const windows = await app
      ?.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => ({
          visible: w.isVisible(),
          focused: w.isFocused(),
          zoom: w.webContents.getZoomFactor(),
          children: w.contentView.children.map((v) => ({
            visible: v.getVisible(),
            bounds: v.getBounds(),
          })),
        })),
      )
      .catch((e) => String(e));
    await fs.writeFile(
      path.join(output, "packaged-geometry.json"),
      JSON.stringify({ geometry, windows }, null, 2),
    );
  }
  await fs.writeFile(path.join(output, "packaged-failure.log"), logs);
  throw error;
} finally {
  await app?.close();
  await fs.rm(temp, { recursive: true, force: true });
}
