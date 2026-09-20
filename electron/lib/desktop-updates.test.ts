import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  profile: "",
  resources: "",
  spawn: vi.fn(),
  quit: vi.fn(),
  show: vi.fn(),
}));
vi.mock("original-fs", async () => import("node:fs"));
vi.mock("electron", () => ({
  app: {
    getPath: () => mocks.profile,
    getVersion: () => "0.1.2",
    quit: mocks.quit,
  },
  dialog: { showMessageBox: mocks.show },
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("./data-paths.js", () => ({
  getResourcePath: (...parts: string[]) => path.join(mocks.resources, ...parts),
}));
import { DesktopUpdates } from "./desktop-updates.js";
let root: string;
let updates: DesktopUpdates;
let child: EventEmitter & {
  unref: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
};
beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-embedded-host-"));
  mocks.profile = path.join(root, "profile");
  mocks.resources = path.join(root, "resources");
  const resource = path.join(
    mocks.resources,
    "updater",
    process.platform === "darwin"
      ? "Synax Updater.app/Contents/Resources"
      : "resources",
  );
  await fs.mkdir(resource, { recursive: true });
  await fs.writeFile(path.join(resource, "app.asar"), "embedded updater");
  child = Object.assign(new EventEmitter(), { unref: vi.fn(), kill: vi.fn() });
  mocks.spawn.mockImplementation(() => {
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
});
afterEach(async () => {
  updates?.stop();
  child.emit("exit", 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await fs.rm(root, { recursive: true, force: true });
});
it("copies and launches a detached updater runtime outside the installation", async () => {
  updates = new DesktopUpdates(
    async () => {},
    () => "1.0.0",
  );
  await updates.check(true);
  const [executable, args, options] = mocks.spawn.mock.calls[0];
  expect(
    executable.startsWith(path.join(mocks.profile, "updater-runtime")),
  ).toBe(true);
  expect(options.detached).toBe(true);
  const request = JSON.parse(await fs.readFile(args[0].slice(10), "utf8"));
  expect(request).toMatchObject({
    currentVersion: "0.1.2",
    uiVersion: "1.0.0",
    parentPid: process.pid,
    background: false,
  });
  await updates.check(true);
  expect(mocks.spawn).toHaveBeenCalledOnce();
  await fs.access(`${args[0].slice(10)}.show`);
  updates.stop();
  expect(child.kill).not.toHaveBeenCalled();
});
it("authenticates host commands and forwards interface checks", async () => {
  const checkUi = vi.fn().mockResolvedValue(undefined);
  updates = new DesktopUpdates(checkUi, () => null);
  await updates.check(true);
  const request = JSON.parse(
    await fs.readFile(mocks.spawn.mock.calls[0][1][0].slice(10), "utf8"),
  );
  expect(
    (await fetch(`${request.controlUrl}quit`, { method: "POST" })).status,
  ).toBe(403);
  expect(mocks.quit).not.toHaveBeenCalled();
  const response = await fetch(`${request.controlUrl}ui-check`, {
    method: "POST",
    headers: { Authorization: `Bearer ${request.token}` },
  });
  expect(response.status).toBe(200);
  expect(checkUi).toHaveBeenCalledOnce();
});
