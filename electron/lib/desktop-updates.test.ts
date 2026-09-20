import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  directory: "",
  find: vi.fn(),
  download: vi.fn(),
  show: vi.fn(),
  quit: vi.fn(),
  install: vi.fn(),
  checkLocation: vi.fn(),
  prepareMac: vi.fn(),
  launchMac: vi.fn(),
  healthy: vi.fn(),
  setFeed: vi.fn(),
  nativeCheck: vi.fn(),
  listeners: new Map<string, (...args: any[]) => void>(),
}));
vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getPath: () => mocks.directory,
    getVersion: () => "0.1.2",
    quit: mocks.quit,
  },
  dialog: { showMessageBox: mocks.show },
  autoUpdater: {
    setFeedURL: mocks.setFeed,
    checkForUpdates: mocks.nativeCheck,
    quitAndInstall: mocks.install,
    once: (event: string, fn: (...args: any[]) => void) =>
      mocks.listeners.set(event, fn),
    removeListener: (event: string) => mocks.listeners.delete(event),
  },
}));
vi.mock("./desktop-update-feed.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./desktop-update-feed.js")>()),
  findDesktopRelease: mocks.find,
  downloadDesktopRelease: mocks.download,
}));
vi.mock("./mac-desktop-update.js", () => ({
  checkMacInstallLocation: mocks.checkLocation,
  prepareMacInstallation: mocks.prepareMac,
  launchMacInstaller: mocks.launchMac,
  finishMacInstallation: mocks.healthy,
}));
import { DesktopUpdates, prepareWindowsUpdate } from "./desktop-updates.js";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
const release = {
  manifest: {
    version: "0.2.0",
    platform: "darwin",
    arch: "arm64",
    artifact: { size: 1 },
  },
};
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.listeners.clear();
  mocks.directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synax-update-interaction-"),
  );
  Object.defineProperty(process, "platform", { value: "darwin" });
  Object.defineProperty(process, "arch", { value: "arm64" });
  mocks.find.mockResolvedValue(release);
  mocks.download.mockResolvedValue("/download.dmg");
  mocks.show.mockResolvedValue({ response: 0 });
  mocks.prepareMac.mockResolvedValue({ version: "0.2.0" });
  mocks.nativeCheck.mockImplementation(() =>
    queueMicrotask(() => mocks.listeners.get("update-downloaded")?.()),
  );
});
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  Object.defineProperty(process, "arch", arch);
  vi.restoreAllMocks();
  await fs.rm(mocks.directory, { recursive: true, force: true });
});
describe("full desktop update interaction", () => {
  it("allows UI updates when no newer desktop release exists", async () => {
    mocks.find.mockResolvedValue(null);
    expect(await new DesktopUpdates().check(true)).toBe(false);
    expect(mocks.show).not.toHaveBeenCalled();
  });
  it("does not repeatedly offer a deferred version in the background", async () => {
    const updates = new DesktopUpdates();
    expect(await updates.check(false)).toBe(true);
    await updates.check(false);
    expect(mocks.show).toHaveBeenCalledOnce();
    expect(mocks.download).not.toHaveBeenCalled();
    await updates.check(true);
    expect(mocks.show).toHaveBeenCalledTimes(2);
  });
  it("downloads without quitting, then installs only after explicit restart", async () => {
    const updates = new DesktopUpdates();
    mocks.show
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValueOnce({ response: 0 });
    await updates.check(true);
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(mocks.quit).not.toHaveBeenCalled();
    expect(mocks.prepareMac).not.toHaveBeenCalled();
    mocks.show.mockResolvedValueOnce({ response: 1 });
    await updates.check(true);
    expect(mocks.prepareMac).toHaveBeenCalledOnce();
    expect(mocks.launchMac).toHaveBeenCalledOnce();
    expect(mocks.quit).toHaveBeenCalledOnce();
  });
  it("never quits if validation or helper startup fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.show.mockResolvedValue({ response: 1 });
    mocks.launchMac.mockRejectedValueOnce(new Error("helper failed"));
    await new DesktopUpdates().check(false);
    expect(mocks.show.mock.lastCall?.[0]).toMatchObject({
      type: "error",
      detail: "helper failed",
    });
    expect(mocks.quit).not.toHaveBeenCalled();
    log.mockRestore();
  });
  it("hands a verified local package to Squirrel and removes event listeners", async () => {
    vi.spyOn(fs, "access").mockResolvedValue();
    const file = path.join(mocks.directory, "Synax-0.2.0-full.nupkg");
    await fs.writeFile(file, "package");
    await prepareWindowsUpdate(mocks.directory, file);
    expect(mocks.setFeed).toHaveBeenCalledWith({ url: mocks.directory });
    expect(
      await fs.readFile(path.join(mocks.directory, "RELEASES"), "utf8"),
    ).toMatch(/^[a-f0-9]{40} Synax-0.2.0-full.nupkg 7\n$/);
    expect(mocks.listeners.size).toBe(0);
  });
  it("propagates Squirrel failure without reporting a ready update", async () => {
    vi.spyOn(fs, "access").mockResolvedValue();
    const file = path.join(mocks.directory, "Synax-0.2.0-full.nupkg");
    await fs.writeFile(file, "package");
    mocks.nativeCheck.mockImplementation(() =>
      mocks.listeners.get("error")?.(new Error("install failed")),
    );
    await expect(prepareWindowsUpdate(mocks.directory, file)).rejects.toThrow(
      "install failed",
    );
    expect(mocks.listeners.size).toBe(0);
  });
});
