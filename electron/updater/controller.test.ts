import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  UpdaterController,
  type ControllerDependencies,
} from "./controller.js";
import { validateUpdaterRequest, type UpdaterRequest } from "./contract.js";
import type { DesktopRelease } from "../lib/desktop-update-feed.js";
let root: string;
let request: UpdaterRequest;
let dependencies: ControllerDependencies;
const release: DesktopRelease = {
  manifest: {
    format: 1,
    version: "0.2.0",
    platform: "darwin",
    arch: "arm64",
    artifact: {
      name: "Synax-0.2.0-darwin-arm64.dmg",
      size: 10,
      sha256: "a".repeat(64),
    },
  },
  url: "https://github.com/coldmint9/Synax/releases/download/v0.2.0/Synax-0.2.0-darwin-arm64.dmg",
  notes: "New version",
};
beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "synax-controller-")),
  );
  request = {
    format: 1,
    currentVersion: "0.1.2",
    uiVersion: null,
    executable: path.join(root, "Synax.app/Contents/MacOS/Synax"),
    profile: root,
    parentPid: process.pid,
    controlUrl: "http://127.0.0.1:32101/",
    token: "a".repeat(64),
    background: false,
  };
  dependencies = {
    find: vi.fn().mockResolvedValue(release),
    download: vi
      .fn()
      .mockResolvedValue(path.join(root, "desktop-updates/package/update.dmg")),
    verify: vi.fn().mockResolvedValue(true),
    install: vi.fn().mockResolvedValue(undefined),
  };
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
it("restores a verified cached download and requires an explicit install action", async () => {
  const controller = new UpdaterController(request, () => {}, dependencies);
  await controller.initialize();
  await controller.check();
  expect(controller.state.phase).toBe("ready");
  expect(dependencies.install).not.toHaveBeenCalled();
  await controller.install();
  expect(controller.state.phase).toBe("complete");
  expect(controller.state.currentVersion).toBe("0.2.0");
  expect(controller.state.uiVersion).toBeNull();
  const reopened = new UpdaterController(request, () => {}, dependencies);
  await reopened.initialize();
  expect(reopened.state.history[0]).toMatchObject({
    version: "0.2.0",
    fromVersion: "0.1.2",
    outcome: "installed",
  });
});
it("records an install failure without marking the new version active", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(dependencies.install).mockRejectedValue(
    new Error("replacement failed"),
  );
  const controller = new UpdaterController(request, () => {}, dependencies);
  await controller.initialize();
  await controller.check();
  await controller.install();
  expect(controller.state).toMatchObject({
    phase: "error",
    currentVersion: "0.1.2",
    message: "replacement failed",
  });
  expect(controller.state.history[0].outcome).toBe("failed");
  log.mockRestore();
});
it("does not run overlapping checks or allow installation before download", async () => {
  let complete!: (value: DesktopRelease) => void;
  vi.mocked(dependencies.find).mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  vi.mocked(dependencies.verify).mockResolvedValue(false);
  const controller = new UpdaterController(request, () => {}, dependencies);
  await controller.initialize();
  const pending = controller.check();
  await controller.check();
  expect(dependencies.find).toHaveBeenCalledOnce();
  complete(release);
  await pending;
  await controller.install();
  expect(dependencies.install).not.toHaveBeenCalled();
});
it("rejects foreign control endpoints and malformed requests", () => {
  expect(validateUpdaterRequest(request)).toEqual(request);
  expect(() =>
    validateUpdaterRequest({ ...request, controlUrl: "https://example.com/" }),
  ).toThrow("endpoint");
  expect(() =>
    validateUpdaterRequest({ ...request, token: "invalid" }),
  ).toThrow("request");
});
