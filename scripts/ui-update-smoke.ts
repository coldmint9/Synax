import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron, type ElectronApplication } from "playwright-core";
import { createUiReleaseArtifacts } from "./ui-release-artifacts.js";

if (process.platform !== "darwin" && process.platform !== "win32") process.exit(0);

const version = JSON.parse(await readFile("package.json", "utf8")).version as string;
const packaged = path.resolve("out", `Synax-${process.platform}-${process.arch}`);
const executablePath = path.join(packaged, process.platform === "darwin"
  ? "Synax.app/Contents/MacOS/Synax" : "Synax.exe");
const resources = process.platform === "darwin"
  ? path.join(packaged, "Synax.app", "Contents", "Resources")
  : path.join(packaged, "resources");
const temp = await mkdtemp(path.join(os.tmpdir(), "Synax UI Smoke "));
const profile = path.join(temp, "profile");
const dataRoot = path.join(temp, "data");
const updates = path.join(profile, "ui-updates", version);
const snapshot = path.join(updates, "ui-1.0.0");
const env: Record<string, string | undefined> = { ...process.env, DATA_ROOT: dataRoot };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_SKIP_SIDECAR;
delete env.NODE_OPTIONS;
let desktop: ElectronApplication | undefined;

async function launch(): Promise<ElectronApplication> {
  return _electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env, timeout: 60_000 });
}

try {
  await mkdir(updates, { recursive: true });
  await cp(path.join(resources, "dist"), snapshot, { recursive: true });
  const index = path.join(snapshot, "index.html");
  const html = await readFile(index, "utf8");
  assert(html.includes("</head>"));
  await writeFile(index, html.replace("</head>", "<!-- ui-update-smoke-marker --></head>"));
  const { manifest } = await createUiReleaseArtifacts(snapshot, "1.0.0", version);
  await writeFile(path.join(snapshot, "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(updates, "state.json"), JSON.stringify({ active: null, previous: null, pending: "1.0.0", awaitingHealth: false, rejected: [] }));

  desktop = await launch();
  let page = await desktop.firstWindow();
  await page.waitForSelector(".workbench-shell", { timeout: 60_000 });
  assert.equal(await page.evaluate(() => document.documentElement.innerHTML.includes("ui-update-smoke-marker")), true);
  const port = await page.evaluate(() => (window as any).electronAPI.getApiPort());
  assert((await fetch(`http://127.0.0.1:${port}/api/health`)).ok);
  await page.waitForFunction(async () => {
    // The UI reports its readiness from the mounted App component.
    return document.documentElement.classList.contains("electron");
  });
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    healthy = JSON.parse(await readFile(path.join(updates, "state.json"), "utf8")).awaitingHealth === false;
    if (healthy) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(healthy, true, "updated UI should acknowledge its first healthy render");
  await desktop.close(); desktop = undefined;

  // Corruption before the next launch must select the bundled UI instead.
  await writeFile(index, "corrupted");
  desktop = await launch();
  page = await desktop.firstWindow();
  await page.waitForSelector(".workbench-shell", { timeout: 60_000 });
  assert.equal(await page.evaluate(() => document.documentElement.innerHTML.includes("ui-update-smoke-marker")), false);
  const state = JSON.parse(await readFile(path.join(updates, "state.json"), "utf8"));
  assert.equal(state.active, null);
  assert(state.rejected.includes("1.0.0"));
  console.log(`UI update smoke passed: ${process.platform}/${process.arch}; activation, API and bundled fallback.`);
} catch (error) {
  await mkdir("out", { recursive: true });
  await writeFile(path.join("out", "ui-update-smoke.log"), error instanceof Error ? error.stack ?? error.message : String(error));
  await desktop?.windows()[0]?.screenshot({ path: path.join("out", "ui-update-smoke.png") }).catch(() => {});
  throw error;
} finally {
  await desktop?.close().catch(() => {});
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
