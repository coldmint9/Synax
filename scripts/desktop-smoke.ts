import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron, type ElectronApplication } from "playwright-core";

const output = path.resolve("out");
const packaged = path.join(output, `Synax-${process.platform}-${process.arch}`);
const executablePath =
  process.argv[2] ??
  path.join(
    packaged,
    process.platform === "darwin"
      ? "Synax.app/Contents/MacOS/Synax"
      : process.platform === "win32"
        ? "Synax.exe"
        : "Synax",
  );
const temp = await mkdtemp(path.join(tmpdir(), "Synax Desktop Smoke "));
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  DATA_ROOT: path.join(temp, "data"),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_SKIP_SIDECAR;
delete env.NODE_OPTIONS;
await mkdir(output, { recursive: true });
let desktop: ElectronApplication | undefined;
let logs = "";
let port = 0;

try {
  desktop = await _electron.launch({
    executablePath,
    args: [`--user-data-dir=${path.join(temp, "profile")}`],
    env,
    timeout: 60_000,
  });
  desktop.process().stdout?.on("data", (data) => {
    logs += data;
  });
  desktop.process().stderr?.on("data", (data) => {
    logs += data;
  });
  const page = await desktop.firstWindow({ timeout: 60_000 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error")
      logs += `\nRenderer console: ${message.text()}\n`;
  });
  await page.waitForFunction(
    () =>
      document.querySelector(".workbench-shell") &&
      (document.documentElement.classList.contains("electron-macos") ||
        document.documentElement.classList.contains("electron-windows") ||
        (window as any).electronAPI?.platform === "linux"),
    undefined,
    { timeout: 30_000 },
  );
  assert.match(page.url(), /^app:\/\//);
  const info = await desktop.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    resources: process.resourcesPath,
    userData: app.getPath("userData"),
  }));
  assert.equal(info.packaged, true);
  assert.equal(
    await realpath(info.userData),
    await realpath(path.join(temp, "profile")),
  );
  const bridge = await page.evaluate(async () => {
    const api = (window as any).electronAPI;
    const port = await api.getApiPort();
    const response = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      headers: { Authorization: `Bearer ${await api.getRuntimeToken()}` },
    });
    return {
      platform: api.platform,
      version: await api.getAppVersion(),
      port,
      status: response.status,
      classes: document.documentElement.className,
    };
  });
  port = bridge.port;
  assert.equal(bridge.platform, process.platform);
  assert.equal(bridge.status, 200, "renderer must reach the authenticated API");
  assert.match(bridge.classes, /\belectron\b/);
  assert.equal(
    bridge.classes.includes("electron-macos"),
    process.platform === "darwin",
  );
  assert.equal(
    bridge.classes.includes("electron-windows"),
    process.platform === "win32",
  );
  assert((await fetch(`http://127.0.0.1:${port}/api/health`)).ok);
  const workspace = path.join(temp, "工作区 with spaces");
  await mkdir(workspace);
  await writeFile(
    path.join(workspace, "index.js"),
    "export const smoke = true;\n",
  );
  const created = await page.evaluate(async (localPath) => {
    const api = (window as any).electronAPI;
    const response = await fetch(
      `http://127.0.0.1:${await api.getApiPort()}/api/projects/workspaces`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await api.getRuntimeToken()}`,
        },
        body: JSON.stringify({ name: "Desktop smoke", roots: [{ localPath }] }),
      },
    );
    const body = await response.json();
    return { status: response.status, id: body.project?.id };
  }, workspace);
  assert.equal(
    created.status,
    201,
    "workspace with Unicode/spaces must be accepted",
  );
  await desktop.evaluate(({ BrowserWindow }, id) => {
    BrowserWindow.getAllWindows()[0].webContents.send(
      "menu:navigate",
      `/projects/${id}/sessions`,
    );
  }, created.id);
  await page.waitForSelector(".work-page");
  await page.reload();
  await page.waitForSelector(".work-page");
  const menus = await desktop.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    return {
      views:
        menu?.items
          .find((item) => item.label === "视图")
          ?.submenu?.items.map((item) => item.label) ?? [],
      updater: menu?.items
        .find((item) => item.label === "帮助")
        ?.submenu?.items.find((item) => item.id === "ui:check-updates")?.label,
    };
  });
  assert(!menus.views.includes("Wiki"));
  assert(!menus.views.includes("Work"));
  if (process.platform === "darwin" || process.platform === "win32")
    assert.equal(menus.updater, "软件更新…");
  await page.waitForSelector(".work-page");
  const chromeHeight = await page
    .locator(".workbench-shell")
    .evaluate((element) =>
      getComputedStyle(element)
        .getPropertyValue("--desktop-titlebar-height")
        .trim(),
    );
  assert.equal(
    chromeHeight === "40px",
    process.platform === "darwin",
    "macOS titlebar insets must not leak into Windows",
  );
  await page.screenshot({ path: path.join(output, "desktop-smoke.png") });
  assert.deepEqual(errors, [], "renderer errors");

  // Execute inside the same embedded Node runtime as the packaged API, not the build host's Node.
  const probe = path.join(temp, "native-check.cjs");
  await writeFile(
    probe,
    String.raw`
    if (process.argv[2] === '--child') {
      process.send({ ok: true }); process.disconnect();
    } else {
      const assert = require('node:assert/strict');
      const req = require('node:module').createRequire(process.argv[2]);
      const Database = req('libsql');
      const db = new Database(':memory:');
      assert.equal(db.prepare('SELECT 1 AS ok').get().ok, 1); db.close();
      const Parser = req('tree-sitter');
      const parser = new Parser(); parser.setLanguage(req('tree-sitter-javascript'));
      assert.equal(parser.parse('const x = 1;').rootNode.hasError, false);
      const child = require('node:child_process').fork(__filename, ['--child'], { execArgv: [], stdio: ['ignore','pipe','pipe','ipc'] });
      let replied = false;
      child.once('message', () => { replied = true; });
      child.once('error', error => { throw error; });
      child.once('exit', code => {
        assert.equal(code, 0); assert(replied, 'backend child process must run as Node');
        process.parentPort.postMessage({ nativeModules: true, childFork: true });
      });
    }
  `,
  );
  const native = await desktop.evaluate(
    async ({ utilityProcess }, { probe, server }) => {
      return await new Promise((resolve, reject) => {
        const child = utilityProcess.fork(probe, [server], { stdio: "pipe" });
        let stderr = "";
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`Native probe timed out: ${stderr}`));
        }, 20_000);
        child.stderr?.on("data", (data) => {
          stderr += data;
        });
        child.once("message", (result) => {
          clearTimeout(timer);
          resolve(result);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(
            new Error(
              `Native probe exited ${code} before reporting success: ${stderr}`,
            ),
          );
        });
      });
    },
    { probe, server: path.join(info.resources, "server-dist", "server.cjs") },
  );
  assert.deepEqual(native, { nativeModules: true, childFork: true });
  console.log(
    `Desktop smoke passed: ${process.platform}/${process.arch}, version ${bridge.version}; renderer, API, native modules and child fork OK.`,
  );
} catch (error) {
  const page = desktop?.windows()[0];
  if (page) {
    await page
      .screenshot({ path: path.join(output, "desktop-smoke.png") })
      .catch(() => {});
    logs += `\nRenderer text: ${await page
      .locator("body")
      .innerText()
      .catch(() => "unavailable")}\n`;
  }
  logs += `\n${error instanceof Error ? error.stack : error}\n`;
  throw error;
} finally {
  await writeFile(path.join(output, "desktop-smoke.log"), logs);
  try {
    await desktop?.close();
  } finally {
    await rm(temp, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
}
if (port) {
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    }),
    "backend must stop when the app quits",
  );
  console.log("Desktop shutdown passed: API stopped.");
}
