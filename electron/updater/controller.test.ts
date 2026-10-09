import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { AppUpdater, UpdateInfo } from "electron-updater";
import { UpdaterController, type ControllerDependencies } from "./controller.js";
import type { UpdaterRequest } from "./contract.js";
import { configureUpdateNetwork } from "../lib/update-network.js";

let root: string;
let request: UpdaterRequest;
let dependencies: ControllerDependencies;
let updater: EventEmitter & {
  checkForUpdates: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
  quitAndInstall: ReturnType<typeof vi.fn>;
};
let info: UpdateInfo;
let file: string;
const bytes = Buffer.from("framework checked installer");
const pending = () => path.join(root, "desktop-updates/framework-pending.json");
function controller(value = request) { return new UpdaterController(value, () => {}, dependencies); }
async function ready() {
  const value = controller();
  await value.initialize(); await value.check(); await value.download();
  expect(value.state.phase).toBe("ready");
  return value;
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-framework-"));
  file = path.join(root, "installer.exe");
  await fs.writeFile(file, bytes);
  request = { currentVersion: "0.1.2", uiVersion: null, executable: path.join(root, "Synax.exe"), profile: root, parentPid: process.pid };
  info = { version: "0.2.0", releaseDate: new Date().toISOString(), releaseNotes: "Release notes", path: file, sha512: "", files: [{ url: file, size: bytes.length, sha512: createHash("sha512").update(bytes).digest("base64") }] };
  updater = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: info })),
    downloadUpdate: vi.fn(async () => [file]),
    quitAndInstall: vi.fn(),
  });
  dependencies = { create: vi.fn(async () => updater as unknown as AppUpdater), configure: vi.fn(async () => {}), eligible: vi.fn(async () => {}) };
  configureUpdateNetwork({ mode: "direct", customProxyUrl: "" });
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

it("uses framework checks and transfers, and waits for verified bytes before readiness", async () => {
  const value = controller(); await value.initialize(); await value.check();
  expect(value.state).toMatchObject({ phase: "available", availableVersion: "0.2.0", notes: "Release notes" });
  updater.downloadUpdate.mockImplementation(async () => {
    updater.emit("download-progress", { percent: 100, transferred: bytes.length, total: bytes.length });
    expect(value.state.phase).toBe("downloading");
    return [file];
  });
  await value.download();
  expect(value.state).toMatchObject({ phase: "ready", progress: 1, transfer: { mode: "full" } });
  await value.install();
  expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  expect(value.state.phase).toBe("installing");
  expect(value.state.history).toEqual([]);
  expect(JSON.parse(await fs.readFile(pending(), "utf8"))).toMatchObject({ version: "0.2.0", fromVersion: "0.1.2" });
});
it("records installation only when the new application confirms startup, once", async () => {
  const value = await ready(); await value.install();
  const restarted = controller({ ...request, currentVersion: "0.2.0" });
  await restarted.initialize(); await restarted.markHealthy(); await restarted.markHealthy();
  expect(restarted.state.history).toHaveLength(1);
  expect(restarted.state.history[0]).toMatchObject({ version: "0.2.0", outcome: "installed" });
  expect(restarted.state.phase).toBe("complete");
  const reopened = controller({ ...request, currentVersion: "0.2.0" });
  await reopened.initialize(); expect(reopened.state.history).toEqual(restarted.state.history);
});
it("records failure if the old application returns, and never confirms another installation path", async () => {
  const value = await ready(); await value.install();
  const unrelated = controller({ ...request, executable: request.executable + ".other" });
  await unrelated.initialize(); await unrelated.markHealthy();
  expect(unrelated.state.history).toEqual([]); await fs.access(pending());
  const old = controller(); await old.initialize(); await old.markHealthy();
  expect(old.state.history[0].outcome).toBe("failed");
});
it("retries failed checks and downloads without duplicating listeners", async () => {
  const value = controller(); await value.initialize();
  updater.checkForUpdates.mockRejectedValueOnce(new Error("offline"));
  await value.check(); expect(value.state.phase).toBe("error");
  await value.check();
  updater.downloadUpdate.mockRejectedValueOnce(new Error("interrupted"));
  await value.download(); expect(value.state.phase).toBe("error");
  await value.download(); expect(value.state.phase).toBe("ready");
  expect(updater.listenerCount("error")).toBe(1);
});
it("coalesces concurrent checks and keeps a ready download", async () => {
  let finish!: () => void;
  updater.checkForUpdates.mockImplementation(async () => { await new Promise<void>((resolve) => { finish = resolve; }); return { isUpdateAvailable: true, updateInfo: info }; });
  const value = controller(); await value.initialize();
  const first = value.check(); const second = value.check();
  await vi.waitFor(() => expect(updater.checkForUpdates).toHaveBeenCalledOnce());
  finish(); await Promise.all([first, second]);
  await value.download(); await value.check();
  expect(updater.checkForUpdates).toHaveBeenCalledOnce();
});
it.each(["download", "install"])("refuses changed bytes during %s", async (stage) => {
  const value = controller(); await value.initialize(); await value.check();
  if (stage === "install") await value.download();
  await fs.writeFile(file, Buffer.alloc(bytes.length, 42));
  if (stage === "download") await value.download(); else await value.install();
  expect(value.state.phase).toBe("error"); expect(updater.quitAndInstall).not.toHaveBeenCalled();
});
it("does not download or quit unsupported installations", async () => {
  dependencies.eligible = vi.fn(async () => { throw new Error("Install NSIS first"); });
  const value = controller(); await value.initialize(); await value.check();
  expect(value.state.message).toContain("NSIS");
  expect(dependencies.create).not.toHaveBeenCalled(); expect(updater.quitAndInstall).not.toHaveBeenCalled();
});
it("uses the latest proxy setting at each check", async () => {
  const value = controller(); await value.initialize(); await value.check();
  configureUpdateNetwork({ mode: "custom", customProxyUrl: "https://proxy.example/" });
  await value.check();
  expect(dependencies.configure).toHaveBeenLastCalledWith(updater, "https://proxy.example/");
});
it("surfaces native installation errors and persists a failed transaction", async () => {
  const value = await ready();
  updater.quitAndInstall.mockImplementation(() => updater.emit("error", new Error("native failure")));
  await value.install();
  await vi.waitFor(() => expect(value.state.history[0]?.outcome).toBe("failed"));
  expect(value.state).toMatchObject({ phase: "error", message: "native failure" });
});
it("leaves the app running if the installation journal cannot be persisted", async () => {
  const value = await ready();
  await fs.mkdir(pending(), { recursive: true });
  await value.install();
  expect(value.state.phase).toBe("error"); expect(updater.quitAndInstall).not.toHaveBeenCalled();
});
it("reports disabled framework checks without fabricating an available release", async () => {
  updater.checkForUpdates.mockResolvedValue(null);
  const value = controller(); await value.initialize(); await value.check();
  expect(value.state.phase).toBe("error"); expect(value.state.availableVersion).toBeNull();
});
