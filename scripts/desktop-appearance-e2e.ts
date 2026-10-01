/** Packaged-app regression: settings -> persistence -> native window -> rendered pixels.
 * Uses Playwright's Electron transport (Browser plugin does not expose native APIs).
 * DATA_ROOT and userData are isolated; no real user configuration is modified.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

if (process.platform !== "darwin") throw new Error("macOS appearance E2E requires macOS");
const executablePath = path.resolve(process.argv[2] ?? "out/Synax-darwin-arm64/Synax.app/Contents/MacOS/Synax");
const output = path.resolve(process.argv[3] ?? "out/desktop-appearance-e2e");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "synax-appearance-e2e-"));
await fs.mkdir(output, { recursive: true });
const env = { ...process.env, DATA_ROOT: path.join(temp, "data") } as Record<string, string>;
for (const key of ["ELECTRON_RUN_AS_NODE", "ELECTRON_SKIP_SIDECAR", "NODE_OPTIONS"]) delete env[key];
let app: ElectronApplication | undefined;
let page!: Page;
let mainId!: number;
const errors: string[] = [];
const consoleErrors: string[] = [];
const expectedConsoleErrors: string[] = [];
let injectingSaveFailure = false;
const evidence: unknown[] = [];
let logs = "";

async function until(check: () => Promise<void>, label: string) {
  const deadline = Date.now() + 15_000;
  let last: unknown;
  do {
    try { await check(); return; } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${last}`);
}

async function launch() {
  app = await _electron.launch({ executablePath, args: [`--user-data-dir=${path.join(temp, "profile")}`], env, timeout: 60_000 });
  app.process().stdout?.on("data", (data) => { logs += data; });
  app.process().stderr?.on("data", (data) => { logs += data; });
  page = await app.firstWindow({ timeout: 60_000 });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (injectingSaveFailure && message.text().includes("500") && message.location().url.includes("/api/config/global")) {
      expectedConsoleErrors.push(message.text());
    } else consoleErrors.push(`${message.text()} (${message.location().url})`);
  });
  await page.waitForSelector(".workbench-shell", { timeout: 60_000 });
  mainId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
  const info = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }));
  assert.equal(info.packaged, true);
  evidence.push({ launch: info });
}

async function navigate(route: string) {
  await app!.evaluate(({ BrowserWindow }, { id, route }) => {
    BrowserWindow.fromId(id)!.webContents.send("menu:navigate", route);
  }, { id: mainId, route });
  await until(async () => { assert.equal(new URL(page.url()).pathname, route.split("?")[0]); }, `navigate ${route}`);
}

async function settings() {
  await navigate("/settings");
  await page.waitForSelector(".appearance-window-material");
}

async function configuration() {
  return page.evaluate(async () => {
    const api = (window as any).electronAPI;
    const response = await fetch(`http://127.0.0.1:${await api.getApiPort()}/api/config/global`, {
      headers: { Authorization: `Bearer ${await api.getRuntimeToken()}` },
    });
    if (!response.ok) throw new Error(`Config HTTP ${response.status}`);
    return (await response.json()).config.macWindowAppearance;
  });
}

async function saved(patch: Record<string, unknown>) {
  await until(async () => {
    const value = await configuration();
    for (const [key, expected] of Object.entries(patch)) assert.equal(value[key], expected, `saved ${key}`);
  }, "persist settings");
}

async function state(enabled: boolean, opacity?: number) {
  await until(async () => {
    const native = await app!.evaluate(({ BrowserWindow }, id) => {
      const win = BrowserWindow.fromId(id)!;
      return { background: win.getBackgroundColor(), opacity: win.getOpacity() };
    }, mainId);
    assert.equal(native.opacity, 1, "never fade text / the whole window");
    // Electron 39 returns #RRGGBB here even for alpha=0. capture() below
    // verifies the real pixels; this value alone is never a transparency proof.
    if (enabled) assert.match(native.background, /^#000000(?:00)?$/, "theme/menu sync must not restore a colored native backing");
    else assert.match(native.background, /^#(?:FF)?[\dA-F]{6}$/, "disabled window has an opaque backing");
    const dom = await page.evaluate(() => ({
      enabled: document.documentElement.dataset.macWindowEnabled,
      opacity: document.documentElement.style.getPropertyValue("--mac-window-opacity"),
    }));
    assert.equal(dom.enabled, String(enabled), "window-wide material survives settings unmount");
    if (opacity !== undefined) assert.equal(Number(dom.opacity), opacity);
  }, "native and renderer appearance");
}

async function capture(label: string, translucent: boolean) {
  // Do not use screenshot({omitBackground:true}): that overrides the backing
  // color and can falsely pass an otherwise opaque native window.
  const shot = await app!.evaluate(async ({ BrowserWindow }, id) => {
    const image = await BrowserWindow.fromId(id)!.capturePage();
    const bitmap = image.toBitmap();
    const size = image.getSize();
    let translucent = 0;
    const histogram = new Array<number>(256).fill(0);
    for (let i = 3; i < bitmap.length; i += 4) {
      histogram[bitmap[i]]++;
      if (bitmap[i] > 0 && bitmap[i] < 250) translucent++;
    }
    const peak = Math.max(...histogram.slice(1, 250));
    const backgroundAlpha = peak === 0 ? 255 : histogram.findIndex((count, alpha) => alpha > 0 && alpha < 250 && count === peak);
    return { png: image.toPNG().toString("base64"), fraction: translucent / (size.width * size.height), backgroundAlpha, size };
  }, mainId);
  await fs.writeFile(path.join(output, `${label}.png`), Buffer.from(shot.png, "base64"));
  evidence.push({ screenshot: label, translucentPixelFraction: shot.fraction, backgroundAlpha: shot.backgroundAlpha, size: shot.size });
  if (translucent && shot.fraction <= 0.1) console.log("OPAQUE LAYERS", await page.evaluate(() =>
    [...document.querySelectorAll("*")].flatMap((el) => {
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      return rect.width * rect.height > innerWidth * innerHeight * 0.4 && style.backgroundColor !== "rgba(0, 0, 0, 0)"
        ? [{ tag: el.tagName, classes: String(el.className), background: style.backgroundColor }] : [];
    })));
  if (translucent) assert.ok(shot.fraction > 0.1, `${label}: actual captured pixels must have alpha; got ${shot.fraction}`);
  else assert.ok(shot.fraction < 0.01, `${label}: disabled view must be opaque; got ${shot.fraction}`);
  return shot;
}

try {
  await launch();
  await settings();
  await state(false);
  await capture("01-default-off", false);
  const enable = () => page.getByRole("checkbox", { name: /启用透明窗口|Enable transparent window/ });
  const density = () => page.getByRole("slider", { name: /毛玻璃浓度|Glass density/ });
  const material = () => page.getByRole("combobox", { name: /原生材质|Native material/ });
  await enable().check();
  await density().fill("0.35");
  await saved({ enabled: true, opacity: 0.35 });
  await state(true, 0.35);
  const lowDensity = await capture("02-light-under-window", true);
  assert.ok(Math.abs(lowDensity.backgroundAlpha - 255 * 0.35) < 2, "low density changes actual framebuffer alpha");
  await material().selectOption("hud-window");
  await saved({ vibrancy: "hud-window" });
  await page.getByRole("radio", { name: /^(Dark|深色)$/ }).check();
  await until(async () => assert.equal(await page.locator("html").evaluate((el) => el.classList.contains("dark")), true), "dark theme");
  await state(true, 0.35);
  await capture("03-dark-hud", true);
  await material().selectOption("none");
  await saved({ vibrancy: "none" });
  await state(true, 0.35);
  await capture("04-no-blur-transparent", true);
  await material().selectOption("under-window");
  await saved({ vibrancy: "under-window" });
  await navigate("/");
  await page.waitForSelector(".appearance-window-material", { state: "detached" });
  await state(true, 0.35);
  await capture("05-after-leaving-settings", true);

  const workspace = path.join(temp, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "README.md"), "Appearance E2E fixture\n");
  execFileSync("git", ["init", "--initial-branch=main", workspace]);
  execFileSync("git", ["-C", workspace, "add", "README.md"]);
  execFileSync("git", ["-C", workspace, "-c", "user.name=Appearance E2E", "-c", "user.email=e2e@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture"]);
  const projectId = await page.evaluate(async (localPath) => {
    const api = (window as any).electronAPI;
    const response = await fetch(`http://127.0.0.1:${await api.getApiPort()}/api/projects/workspaces`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${await api.getRuntimeToken()}` },
      body: JSON.stringify({ name: "Appearance E2E", roots: [{ localPath }] }),
    });
    if (response.status !== 201) throw new Error(`Workspace HTTP ${response.status}: ${await response.text()}`);
    return (await response.json()).project.id as string;
  }, workspace);
  await navigate(`/projects/${projectId}/sessions`);
  await page.waitForSelector(".work-page");
  await state(true, 0.35);
  await capture("06-dark-workspace", true);
  await page.reload();
  await page.waitForSelector(".work-page");
  await state(true, 0.35);
  await capture("07-workspace-reloaded", true);
  await navigate(`/projects/${projectId}/sessions/new`);
  await page.waitForSelector(".agent-session-composer-shell");
  await state(true, 0.35);
  await capture("07b-new-conversation", true);

  await app!.close(); app = undefined;
  await launch();
  await state(true, 0.35);
  await capture("08-restarted", true);
  await settings();
  await until(async () => assert.equal(await enable().isChecked(), true), "persisted checkbox");
  // Rapid input changes must keep the final value in both the file and native UI.
  await density().fill("0.55"); await density().fill("0.7"); await density().fill("0.9");
  await saved({ opacity: 0.9 }); await state(true, 0.9);
  const highDensity = await capture("09-high-density", true);
  assert.ok(highDensity.backgroundAlpha > lowDensity.backgroundAlpha + 100, "the slider must change rendered alpha, not just the saved setting");

  // Simulated persistence failure must restore both the backing and preview.
  injectingSaveFailure = true;
  await page.route("**/api/config/global", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "appearance-e2e-save-failure" }) });
    } else await route.continue();
  });
  await enable().uncheck();
  await until(async () => assert.equal(await enable().isChecked(), true), "rollback checkbox after save failure");
  await state(true, 0.9);
  await saved({ enabled: true, opacity: 0.9 });
  await page.unroute("**/api/config/global");
  injectingSaveFailure = false;
  await enable().uncheck();
  await saved({ enabled: false }); await state(false);
  await capture("10-disabled-again", false);
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleErrors, []);
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  evidence.push({ status: "passed", pageErrors: errors, consoleErrors, expectedConsoleErrors });
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence.push({ status: "failed", error: String(error) });
  throw error;
} finally {
  await app?.close().catch(() => app?.process().kill());
  await fs.writeFile(path.join(output, "results.json"), JSON.stringify(evidence, null, 2));
  await fs.writeFile(path.join(output, "runtime.log"), logs);
  await fs.rm(temp, { recursive: true, force: true });
}
