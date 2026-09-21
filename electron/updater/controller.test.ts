import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  UpdaterController,
  type ControllerDependencies,
} from "./controller.js";
import type { UpdaterRequest } from "./contract.js";
import {
  desktopArtifactName,
  downloadDesktopRelease,
  verifyDesktopArtifact,
  type DesktopRelease,
} from "../lib/desktop-update-feed.js";
import { sha256 } from "../lib/ui-update-format.js";
import { desktopReleaseDirectory } from "../lib/desktop-update-cache.js";
let root: string;
let request: UpdaterRequest;
let dependencies: ControllerDependencies;
const release: DesktopRelease = {
  manifest: {
    format: 1,
    version: "0.2.0",
    platform: process.platform === "win32" ? "win32" : "darwin",
    arch: process.arch as "arm64" | "x64",
    artifact: {
      name: desktopArtifactName(
        "0.2.0",
        process.platform === "win32" ? "win32" : "darwin",
        process.arch as "arm64" | "x64",
      ),
      size: 10,
      sha256: "a".repeat(64),
    },
  },
  url: `https://github.com/coldmint9/Synax/releases/download/v0.2.0/${desktopArtifactName("0.2.0", process.platform === "win32" ? "win32" : "darwin", process.arch as "arm64" | "x64")}`,
  notes: "New version",
};
beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "synax-controller-")),
  );
  request = {
    currentVersion: "0.1.2",
    uiVersion: null,
    executable: path.join(root, "Synax.app/Contents/MacOS/Synax"),
    profile: root,
    parentPid: process.pid,
  };
  await fs.mkdir(path.dirname(request.executable), { recursive: true });
  await fs.writeFile(path.resolve(request.executable, "../../Update.exe"), "");
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});
it.skipIf(!["darwin", "win32"].includes(process.platform))(
  "streams a real artifact into a persistent cache and restores it offline after a new controller starts",
  async () => {
    const bytes = Buffer.from("complete and verified desktop package");
    const downloadable = {
      ...release,
      manifest: {
        ...release.manifest,
        artifact: {
          ...release.manifest.artifact,
          size: bytes.length,
          sha256: sha256(bytes),
        },
      },
    };
    const fetch = vi.fn(async () => new Response(bytes));
    vi.stubGlobal("fetch", fetch);
    dependencies.find = vi.fn().mockResolvedValue(downloadable);
    dependencies.download = vi.fn(downloadDesktopRelease);
    dependencies.verify = verifyDesktopArtifact;
    const controller = new UpdaterController(request, () => {}, dependencies);
    await controller.initialize();
    await controller.check();
    expect(controller.state.phase).toBe("available");
    await controller.download();
    expect(controller.state.phase).toBe("ready");
    const directory = desktopReleaseDirectory(
      controller.directory,
      downloadable.manifest,
    );
    expect(
      await fs.readFile(
        path.join(directory, downloadable.manifest.artifact.name),
      ),
    ).toEqual(bytes);
    vi.mocked(dependencies.find)
      .mockClear()
      .mockRejectedValue(new Error("offline"));
    const restarted = new UpdaterController(request, () => {}, dependencies);
    await restarted.initialize();
    expect(restarted.state).toMatchObject({
      phase: "ready",
      progress: 1,
      size: bytes.length,
    });
    await restarted.check();
    expect(dependencies.find).not.toHaveBeenCalled();
    expect(dependencies.download).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(dependencies.install).not.toHaveBeenCalled();
  },
);
it("publishes streamed progress and remains non-installable until verification and cache persistence finish", async () => {
  const changed = vi.fn();
  let finishDownload!: (file: string) => void;
  let finishVerification!: (valid: boolean) => void;
  vi.mocked(dependencies.verify)
    .mockResolvedValueOnce(false)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishVerification = resolve;
        }),
    );
  vi.mocked(dependencies.download).mockImplementation(
    async (_release, _directory, progress) => {
      progress?.(0.25);
      return new Promise((resolve) => {
        finishDownload = resolve;
      });
    },
  );
  const controller = new UpdaterController(request, changed, dependencies);
  await controller.initialize();
  await controller.check();
  const download = controller.download();
  await vi.waitFor(() =>
    expect(controller.state).toMatchObject({
      phase: "downloading",
      progress: 0.25,
    }),
  );
  await controller.install();
  expect(dependencies.install).not.toHaveBeenCalled();
  const directory = desktopReleaseDirectory(
    controller.directory,
    release.manifest,
  );
  finishDownload(path.join(directory, release.manifest.artifact.name));
  await vi.waitFor(() => expect(controller.state.phase).toBe("verifying"));
  await expect(
    fs.access(path.join(directory, "release.json")),
  ).rejects.toThrow();
  await controller.install();
  expect(dependencies.install).not.toHaveBeenCalled();
  finishVerification(true);
  await download;
  expect(controller.state).toMatchObject({ phase: "ready", progress: 1 });
  expect(
    JSON.parse(await fs.readFile(path.join(directory, "release.json"), "utf8")),
  ).toEqual(release);
  expect(
    changed.mock.calls.some(
      ([state]) => state.phase === "downloading" && state.progress === 0.25,
    ),
  ).toBe(true);
});

it.skipIf(!["darwin", "win32"].includes(process.platform))(
  "restores a cached version after restart and permits checking while offline without redownloading",
  async () => {
    const first = new UpdaterController(request, () => {}, dependencies);
    await first.initialize();
    await first.check();
    vi.mocked(dependencies.find)
      .mockClear()
      .mockRejectedValue(new Error("offline"));
    const restarted = new UpdaterController(request, () => {}, dependencies);
    await restarted.initialize();
    expect(restarted.state).toMatchObject({
      phase: "ready",
      availableVersion: "0.2.0",
      progress: 1,
    });
    await restarted.check();
    expect(restarted.state.phase).toBe("ready");
    expect(dependencies.find).not.toHaveBeenCalled();
    expect(dependencies.download).not.toHaveBeenCalled();
    expect(dependencies.install).not.toHaveBeenCalled();
  },
);

it("does not persist failed verification or allow installation of a changed cache", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(dependencies.verify).mockResolvedValue(false);
  const controller = new UpdaterController(request, () => {}, dependencies);
  await controller.initialize();
  await controller.check();
  await controller.download();
  expect(controller.state.phase).toBe("error");
  const metadata = path.join(
    desktopReleaseDirectory(controller.directory, release.manifest),
    "release.json",
  );
  await expect(fs.access(metadata)).rejects.toThrow();
  await controller.install();
  expect(dependencies.install).not.toHaveBeenCalled();
  vi.mocked(dependencies.verify).mockResolvedValue(true);
  await controller.check();
  expect(controller.state.phase).toBe("ready");
  vi.mocked(dependencies.verify).mockResolvedValue(false);
  await controller.install();
  expect(controller.state).toMatchObject({
    phase: "error",
    message: "安装包校验失败，请重新下载。",
  });
  expect(dependencies.install).not.toHaveBeenCalled();
  await expect(fs.access(metadata)).rejects.toThrow();
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
  await vi.waitFor(() => expect(dependencies.find).toHaveBeenCalledOnce());
  complete(release);
  await pending;
  await controller.install();
  expect(dependencies.install).not.toHaveBeenCalled();
});
