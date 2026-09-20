import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { _electron, type ElectronApplication } from "playwright-core";
import { updaterExecutable } from "../electron/updater/paths.js";
import type { UpdaterRequest } from "../electron/updater/contract.js";

if (!["darwin", "win32"].includes(process.platform)) process.exit(0);
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "Synax Embedded Updater Smoke "),
);
const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
await new Promise<void>((resolve, reject) => {
  parent.once("spawn", resolve);
  parent.once("error", reject);
});
const server = createServer((_request, response) => response.end("ok"));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("No control port");
const request: UpdaterRequest = {
  format: 1,
  currentVersion: "0.1.2",
  uiVersion: "1.0.0",
  executable: path.join(root, "Synax.app/Contents/MacOS/Synax"),
  profile: root,
  parentPid: parent.pid!,
  controlUrl: `http://127.0.0.1:${address.port}/`,
  token: "a".repeat(64),
  background: false,
};
const requestFile = path.join(root, "request.json");
await fs.writeFile(requestFile, JSON.stringify(request));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
let updater: ElectronApplication | undefined;
let host: ElectronApplication | undefined;
let detachedPid: number | undefined;
let stage = "launch standalone updater";
function checkpoint(message: string): void {
  stage = message;
  console.log(`[embedded-updater-smoke] ${message}`);
}
// ElectronApplication.close() has no timeout of its own. Keep a stuck process
// from consuming the entire build job, including during failure cleanup.
const watchdog = setTimeout(() => {
  console.error(`[embedded-updater-smoke] Timed out during: ${stage}`);
  process.exit(1);
}, 180_000);
try {
  checkpoint("launch standalone updater");
  updater = await _electron.launch({
    executablePath: updaterExecutable(path.resolve("out/updater")),
    args: [`--request=${requestFile}`],
    env,
    timeout: 30_000,
  });
  // Replace transport in the test process, without shipping a test feed override.
  await updater.evaluate(() => {
    globalThis.fetch = async () => new Response("[]");
  });
  const page = await updater.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.locator("#current").filter({ hasText: "0.1.2" }).waitFor();
  await page.waitForFunction(
    () => !(document.getElementById("check") as HTMLButtonElement).disabled,
    undefined,
    { timeout: 60_000 },
  );
  await page.locator("#check").click();
  await page
    .locator("#message")
    .filter({ hasText: "当前软件已是最新版本" })
    .waitFor();
  assert.equal(
    await updater.evaluate(({ app }) => app.getName()),
    "Synax Updater",
  );
  assert.equal(await page.locator("#ui-version").textContent(), "1.0.0");
  assert.notEqual(updater.process().pid, parent.pid);
  const exited = new Promise((resolve) => parent.once("exit", resolve));
  parent.kill();
  await exited;
  await page.locator("#check").click();
  await page
    .locator("#message")
    .filter({ hasText: "当前软件已是最新版本" })
    .waitFor();
  await fs.mkdir("out", { recursive: true });
  await page.screenshot({ path: "out/embedded-updater-smoke.png" });
  checkpoint("close standalone updater");
  await updater.close();
  updater = undefined;

  // Exercise the real host bridge inside Electron, including original-fs copying
  // of the opaque app.asar and launching the copied runtime as a detached child.
  const fixture = path.join(root, "host-fixture");
  checkpoint("copy embedded runtime to host fixture");
  await fs.mkdir(fixture);
  await fs.cp(path.resolve("out/updater"), path.join(fixture, "updater"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  await fs.writeFile(
    path.join(fixture, "package.json"),
    JSON.stringify({
      name: "synax-updater-host-smoke",
      version: "0.1.2",
      main: "main.cjs",
    }),
  );
  const hostModule = pathToFileURL(
    path.resolve("dist-electron/lib/desktop-updates.js"),
  ).href;
  await fs.writeFile(
    path.join(fixture, "main.cjs"),
    `const {app, dialog} = require('electron');
app.setPath('userData', ${JSON.stringify(path.join(root, "host-profile"))});
dialog.showMessageBox = async options => { globalThis.hostError = options.detail; return {response: 0}; };
app.whenReady().then(async () => {
  try {
    const {DesktopUpdates} = await import(${JSON.stringify(hostModule)});
    globalThis.updates = new DesktopUpdates(async () => {}, () => null);
    await globalThis.updates.check(true);
  } catch(error) { globalThis.hostError = String(error); }
  globalThis.hostReady = true;
});`,
  );
  checkpoint("launch host bridge fixture");
  host = await _electron.launch({ args: [fixture], env, timeout: 30_000 });
  const limit = Date.now() + 30_000;
  while (!(await host.evaluate(() => (globalThis as any).hostReady))) {
    if (Date.now() > limit)
      throw new Error("Embedded host did not launch the updater");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const result = await host.evaluate(() => ({
    error: (globalThis as any).hostError,
    pid: (globalThis as any).updates?.child?.pid,
    runtime: (globalThis as any).updates?.child?.spawnfile,
  }));
  assert.equal(result.error, undefined);
  assert(
    result.runtime.startsWith(
      path.join(root, "host-profile", "updater-runtime"),
    ),
  );
  detachedPid = result.pid;
  assert(detachedPid);
  checkpoint("close host and verify detached updater survives");
  await host.close();
  host = undefined;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  process.kill(detachedPid, 0);
  console.log(
    "Embedded updater smoke passed: standalone app, version window, raw runtime copy, isolated profile, real host bridge and detached survival after host exit.",
  );
} finally {
  checkpoint(`cleanup after: ${stage}`);
  await updater?.close();
  await host?.close();
  if (detachedPid) {
    try {
      process.kill(detachedPid);
    } catch {
      /* Already exited. */
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        process.kill(detachedPid, 0);
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  parent.kill();
  server.close();
  await fs.rm(root, { recursive: true, force: true });
  clearTimeout(watchdog);
}
