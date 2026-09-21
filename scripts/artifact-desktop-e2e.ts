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
const source = `<!doctype html><html><head><style>body{margin:0;padding:16px;font:14px system-ui;background:#f7f7fa;color:#30343b}button{padding:12px;border:1px solid #888;border-radius:10px}#detail[hidden]{display:none}</style></head><body><button data-qa-id="summary" id="toggle">Mini · Demo</button><p id="detail" hidden>Detail · 21.4K context · synthetic data</p><script>(async()=>{const sdk=window.synaxWidget;await sdk.ready();let expanded=!!sdk.getState().privateState?.expanded;const render=()=>{document.getElementById('detail').hidden=!expanded;document.getElementById('toggle').textContent=expanded?'Detail · Demo':'Mini · Demo';};render();document.getElementById('toggle').addEventListener('click',()=>{expanded=!expanded;render();void sdk.setState({privateState:{expanded},modelState:{view:expanded?'detail':'mini'}});});await sdk.registerControls([{key:'density',label:'Density',type:'toggle',defaultValue:false}],{schemaVersion:1});sdk.onControlsChange(v=>document.body.style.padding=v.density?'8px':'16px');})();</script></body></html>`;
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
const { publishSessionArtifact } =
  await import("../api/services/agent-runtime/artifact-integration.js");
const { closeDb } = await import("../api/db/index.js");
const session = agentSessionRuntime.create({
  projectId: "artifact-app",
  profileId: "executor",
  prompt: "Synthetic artifact desktop acceptance",
  workDir: workspace,
});
agentRuntimeStore.updateSession(session.id, { status: "completed" });
const revision = await publishSessionArtifact(session.id, {
  sourcePath: "demo.html",
  title: "Runtime desktop QA",
  sourceKind: "html",
  idempotencyKey: "desktop-acceptance",
});
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
  const card = page.getByRole("region", {
    name: "Artifact: Runtime desktop QA",
  });
  await card
    .getByRole("button", { name: /运行交互内容|Run interactive content/ })
    .waitFor();
  await card
    .getByRole("button", { name: /运行交互内容|Run interactive content/ })
    .click();
  await card.getByRole("button", { name: /^暂停$|^Pause$/ }).waitFor();
  await card.getByText(/独立桌面预览|Dedicated desktop preview/).waitFor();
  await card
    .getByRole("button", { name: /截取原型|Capture prototype/ })
    .waitFor();
  await card
    .getByRole("button", { name: /截取原型|Capture prototype/ })
    .click();
  const image = card.getByRole("img", {
    name: /待确认的原型截图|Screenshot preview awaiting confirmation/,
  });
  await image.waitFor();
  assert.ok(await image.getAttribute("src"));
  check("real packaged native capture shown for host review");
  await card
    .getByRole("button", {
      name: /确认附加此截图|Confirm screenshot attachment/,
    })
    .click();
  await card
    .getByRole("img", {
      name: /已确认的截图附件|Confirmed screenshot attachment/,
    })
    .waitFor();
  check("bounded screenshot upload through production auth and sidecar");
  await card.getByRole("tab", { name: "QA", exact: true }).click();
  await card
    .getByRole("textbox", { name: /希望如何修改|What should change/ })
    .fill("Retain the model label; make the summary denser. Synthetic QA.");
  await card.getByRole("button", { name: /预审反馈|Review feedback/ }).click();
  const dialog = page.getByRole("dialog", {
    name: /向智能体发送反馈|Send feedback to the agent/,
  });
  await dialog.waitFor();
  assert.equal(await dialog.getByRole("img").count(), 1);
  assert.ok(
    await dialog
      .getByRole("button", { name: /确认并发送|Confirm and send/ })
      .isEnabled(),
  );
  await page.screenshot({
    path: path.join(output, "packaged-feedback-confirmation.png"),
  });
  check(
    "production feedback confirmation includes captured image; preview hidden behind modal",
  );
  await dialog.getByRole("button", { name: /继续编辑|Keep editing/ }).click();
  await card.getByRole("tab", { name: /预览|Preview/ }).click();
  await card.getByRole("button", { name: /放大产物|Expand artifact/ }).click();
  await card
    .getByRole("button", { name: /收起产物|Collapse artifact/ })
    .waitFor();
  await card
    .getByRole("button", { name: /截取原型|Capture prototype/ })
    .click();
  await image.waitFor();
  check("same dedicated view moves into expanded host and still captures");
  await card
    .getByRole("button", { name: /丢弃截图|Discard screenshot/ })
    .click();
  await card
    .getByRole("button", { name: /收起产物|Collapse artifact/ })
    .click();
  await card.getByRole("button", { name: /^暂停$|^Pause$/ }).click();
  await card
    .getByRole("button", { name: /运行交互内容|Run interactive content/ })
    .waitFor();
  await page.reload();
  await card
    .getByRole("button", { name: /运行交互内容|Run interactive content/ })
    .waitFor();
  check("pause and app reload preserve committed artifact reference");
  const token = (
    await fs.readFile(path.join(env.DATA_ROOT, "runtime-access-token"), "utf8")
  ).trim();
  const port = await page.evaluate(() =>
    (window as any).electronAPI.getApiPort(),
  );
  const headers = { Authorization: `Bearer ${token}` };
  const response = await fetch(
    `http://127.0.0.1:${port}/api/agent-runtime/sessions/${session.id}/artifacts/revisions/${revision.revisionId}/export?format=html`,
    { headers },
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes("synaxWidget"));
  assert.ok(!html.includes(token));
  await fs.writeFile(path.join(output, "packaged-export.html"), html);
  check("packaged offline export has SDK and no runtime credentials");
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
