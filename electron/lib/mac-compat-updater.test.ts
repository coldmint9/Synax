import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateInfo } from "electron-updater";
import type { DownloadUpdateOptions } from "electron-updater/out/AppUpdater.js";

type UpdateFile = { url: URL; size: number; sha512: string };

const mocks = vi.hoisted(() => ({
  root: "",
  payload: Buffer.from("Synax 0.2.0 darwin application ZIP payload"),
  order: [] as string[],
  files: null as string[] | null,
  codesign: { error: null as Error | null, stdout: "", stderr: "" },
  installation: { workspace: "installation-workspace" } as unknown,
  executors: [] as unknown[],
  getPath: vi.fn(),
  quit: vi.fn(),
  execFile: vi.fn(),
  transfer: vi.fn(),
  executeDownload: vi.fn(),
  dispatch: vi.fn(),
  emit: vi.fn(),
  prepare: vi.fn(),
  launch: vi.fn(),
}));

vi.mock("electron", () => ({
  default: { app: { getPath: mocks.getPath, quit: mocks.quit } },
}));

// `codesign` is invoked through promisify(execFile); mirror Node's custom
// promisified execFile so the stderr handed to the callback reaches the caller.
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = mocks.execFile as unknown as Record<PropertyKey, unknown>;
  execFile[promisify.custom] = (file: string, args: string[]) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      mocks.execFile(
        file,
        args,
        {},
        (error: Error | null, stdout: string, stderr: string) => {
          if (!error) return resolve({ stdout, stderr });
          Object.assign(error, { stdout, stderr });
          reject(error);
        },
      );
    });
  return { execFile: mocks.execFile, spawn: vi.fn() };
});

vi.mock("electron-updater/out/AppUpdater.js", () => ({
  AppUpdater: class {
    executeDownload = mocks.executeDownload;
    dispatchUpdateDownloaded = mocks.dispatch;
    emit = mocks.emit;
  },
}));

vi.mock("electron-updater/out/providers/Provider.js", () => ({
  findFile: (files: Array<{ url: URL }>, extension: string) =>
    files.find((file) =>
      file.url.pathname.toLowerCase().endsWith(`.${extension}`),
    ) ?? null,
}));

vi.mock("electron-updater/out/electronHttpExecutor.js", () => ({
  ElectronHttpExecutor: class {
    download = mocks.transfer;
    constructor(login: unknown) {
      mocks.executors.push(login);
    }
  },
}));

vi.mock("./mac-desktop-update.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mac-desktop-update.js")>()),
  prepareMacInstallation: mocks.prepare,
  launchMacInstaller: mocks.launch,
}));

import {
  AdHocMacUpdater,
  needsMacCompatibilityUpdater,
} from "./mac-compat-updater.js";

const zipName = `Synax-0.2.0-darwin-${process.arch}.zip`;
const applicationPath = () =>
  path.join(mocks.root, "Applications", "Synax.app");
const executablePath = () =>
  path.join(applicationPath(), "Contents", "MacOS", "Synax");
const downloadDirectory = () => path.join(mocks.root, "cache");
const destination = () => path.join(downloadDirectory(), zipName);
const updateDirectory = () => path.join(mocks.root, "desktop-updates");
const zipUrl = () => new URL(`https://updates.example/${zipName}`);
const digest = (algorithm: "sha256" | "sha512") =>
  createHash(algorithm).update(mocks.payload).digest(
    algorithm === "sha256" ? "hex" : "base64",
  );
const updateFiles = (): UpdateFile[] => [
  { url: zipUrl(), size: mocks.payload.length, sha512: digest("sha512") },
];
const updateInfo = () =>
  ({
    version: "0.2.0",
    releaseDate: "2026-01-01T00:00:00.000Z",
    releaseNotes: "",
    path: "",
    sha512: "",
    files: updateFiles(),
  }) as unknown as UpdateInfo;
const downloadOptions = (files: UpdateFile[] = updateFiles()) =>
  ({
    updateInfoAndProvider: { info: updateInfo(), provider: { resolveFiles: () => files } },
  }) as unknown as DownloadUpdateOptions;
const download = (updater: AdHocMacUpdater, options: DownloadUpdateOptions) =>
  (
    updater as unknown as {
      doDownloadUpdate(value: DownloadUpdateOptions): Promise<string[]>;
    }
  ).doDownloadUpdate(options);
type ExecuteOptions = {
  fileExtension: string;
  fileInfo: { url: URL };
  task(destination: string, options: unknown): Promise<unknown>;
  done(event: unknown): Promise<void>;
};

async function downloaded(): Promise<AdHocMacUpdater> {
  const updater = new AdHocMacUpdater();
  await expect(download(updater, downloadOptions())).resolves.toEqual([
    destination(),
  ]);
  expect(await fs.readFile(destination(), "utf8")).toBe(
    mocks.payload.toString(),
  );
  return updater;
}

beforeEach(async () => {
  mocks.root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "synax-mac-compat-")),
  );
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.executors.length = 0;
  mocks.files = null;
  mocks.payload = Buffer.from("Synax 0.2.0 darwin application ZIP payload");
  mocks.codesign = { error: null, stdout: "", stderr: "" };
  mocks.installation = { workspace: path.join(mocks.root, "workspace") };
  mocks.getPath.mockReturnValue(mocks.root);
  mocks.quit.mockImplementation(() => {
    mocks.order.push("quit");
  });
  mocks.execFile.mockImplementation(
    (_file: string, _args: string[], _options: unknown, callback: Function) => {
      callback(mocks.codesign.error, mocks.codesign.stdout, mocks.codesign.stderr);
    },
  );
  mocks.transfer.mockImplementation(
    async (_url: URL, target: string): Promise<void> => {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, mocks.payload);
    },
  );
  mocks.executeDownload.mockImplementation(async (options: ExecuteOptions) => {
    const target = path.join(
      downloadDirectory(),
      path.basename(options.fileInfo.url.pathname),
    );
    await options.task(target, { headers: {} });
    const files = mocks.files ?? [target];
    await options.done({ files });
    return files;
  });
  mocks.prepare.mockImplementation(async () => {
    mocks.order.push("prepare");
    return mocks.installation;
  });
  mocks.launch.mockImplementation(async () => {
    mocks.order.push("launch");
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(mocks.root, { recursive: true, force: true });
});

describe("macOS compatibility installer detection", () => {
  it("routes an unsigned bundle to the compatibility installer", async () => {
    mocks.codesign.error = new Error(
      "Command failed: /usr/bin/codesign -dv --verbose=4",
    );
    mocks.codesign.stderr = `${applicationPath()}: code object is not signed at all\nIn subcomponent: ${applicationPath()}`;
    await expect(needsMacCompatibilityUpdater(executablePath())).resolves.toBe(
      true,
    );
    expect(mocks.execFile).toHaveBeenCalledWith(
      "/usr/bin/codesign",
      ["-dv", "--verbose=4", applicationPath()],
      {},
      expect.any(Function),
    );
  });

  it("routes an ad-hoc signature with no team identifier to the compatibility installer", async () => {
    mocks.codesign.stderr = [
      `Executable=${executablePath()}`,
      "Identifier=com.Synax.desktop",
      "Signature=adhoc",
      "TeamIdentifier=not set",
      "",
    ].join("\n");
    await expect(needsMacCompatibilityUpdater(executablePath())).resolves.toBe(
      true,
    );
  });

  it("routes a self-signed bundle without a team identifier to the compatibility installer", async () => {
    mocks.codesign.stderr = [
      `Executable=${executablePath()}`,
      "Identifier=com.Synax.desktop",
      "Authority=Synax Local Development",
      "",
    ].join("\n");
    await expect(needsMacCompatibilityUpdater(executablePath())).resolves.toBe(
      true,
    );
  });

  it("keeps the native updater for Developer ID signed bundles", async () => {
    mocks.codesign.stderr = [
      `Executable=${executablePath()}`,
      "Identifier=com.Synax.desktop",
      "Authority=Developer ID Application: Synax Inc. (ABCDE12345)",
      "TeamIdentifier=ABCDE12345",
      "",
    ].join("\n");
    await expect(needsMacCompatibilityUpdater(executablePath())).resolves.toBe(
      false,
    );
  });

  it("does not downgrade a signed app when codesign fails unexpectedly", async () => {
    mocks.codesign.error = new Error("Command failed: /usr/bin/codesign -dv");
    mocks.codesign.stderr = `${applicationPath()}: resource fork, Finder information, or similar detritus not allowed`;
    await expect(needsMacCompatibilityUpdater(executablePath())).rejects.toBe(mocks.codesign.error);
    mocks.codesign.error = new Error("spawn /usr/bin/codesign ENOENT");
    mocks.codesign.stderr = "";
    await expect(needsMacCompatibilityUpdater(executablePath())).rejects.toThrow(
      /ENOENT/,
    );
  });
});

describe("AdHocMacUpdater downloads", () => {
  it("downloads the application ZIP through one shared executor", async () => {
    const updater = new AdHocMacUpdater();
    await expect(download(updater, downloadOptions())).resolves.toEqual([
      destination(),
    ]);
    expect(mocks.executeDownload).toHaveBeenCalledTimes(1);
    const call = mocks.executeDownload.mock.calls[0][0] as ExecuteOptions;
    expect(call.fileExtension).toBe("zip");
    expect(call.fileInfo.url.pathname.endsWith(".zip")).toBe(true);
    expect(mocks.transfer).toHaveBeenCalledTimes(1);
    expect(mocks.transfer.mock.calls[0][0]).toEqual(zipUrl());
    expect(mocks.transfer.mock.calls[0][1]).toBe(destination());
    expect(mocks.dispatch).toHaveBeenCalledWith({ files: [destination()] });
    expect(mocks.executors).toHaveLength(1);
    await download(updater, downloadOptions());
    expect(mocks.executeDownload).toHaveBeenCalledTimes(2);
    expect(mocks.executors).toHaveLength(1);
  });

  it("rejects a release that offers no application ZIP and keeps running", async () => {
    const updater = new AdHocMacUpdater();
    await expect(
      download(updater, downloadOptions([
        { url: new URL("https://updates.example/Synax-0.2.0.dmg"), size: 1, sha512: "x" },
      ])),
    ).rejects.toThrow(/requires an application ZIP/);
    expect(mocks.executeDownload).not.toHaveBeenCalled();
    expect(mocks.transfer).not.toHaveBeenCalled();
    await expect(updater.quitAndInstall()).rejects.toThrow(
      "请先下载更新安装包。",
    );
    expect(mocks.quit).not.toHaveBeenCalled();
  });

  it("rejects a download that does not resolve to exactly one file", async () => {
    mocks.files = [destination(), path.join(downloadDirectory(), "extra.zip")];
    await expect(download(new AdHocMacUpdater(), downloadOptions())).rejects.toThrow(
      /exactly one application ZIP/,
    );
  });

  it("forgets a previous archive once a new download fails", async () => {
    const updater = await downloaded();
    mocks.executeDownload.mockRejectedValueOnce(new Error("network down"));
    await expect(download(updater, downloadOptions())).rejects.toThrow(
      "network down",
    );
    await expect(updater.quitAndInstall()).rejects.toThrow(
      "请先下载更新安装包。",
    );
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});

describe("AdHocMacUpdater installation", () => {
  it("prepares the replacement, launches the helper and then quits", async () => {
    const updater = await downloaded();
    await expect(updater.quitAndInstall()).resolves.toBeUndefined();
    expect(mocks.order).toEqual(["prepare", "launch", "quit"]);
    expect(mocks.getPath).toHaveBeenCalledWith("userData");
    expect((await fs.lstat(updateDirectory())).isDirectory()).toBe(true);
    expect(mocks.prepare).toHaveBeenCalledWith(
      destination(),
      {
        format: 1,
        version: "0.2.0",
        platform: "darwin",
        arch: process.arch,
        artifact: { name: zipName, size: mocks.payload.length, sha256: digest("sha256") },
        updateArchive: { name: zipName, size: mocks.payload.length, sha256: digest("sha256") },
      },
      process.execPath,
      updateDirectory(),
    );
    expect(mocks.launch).toHaveBeenCalledWith(
      mocks.installation,
      updateDirectory(),
      process.pid,
      [`--user-data-dir=${mocks.root}`],
    );
  });

  it("keeps running when preparation fails and can be retried", async () => {
    const updater = await downloaded();
    mocks.prepare.mockImplementationOnce(async () => {
      mocks.order.push("prepare");
      throw new Error("Insufficient free space");
    });
    await expect(updater.quitAndInstall()).rejects.toThrow(
      "Insufficient free space",
    );
    expect(mocks.order).toEqual(["prepare"]);
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
    await expect(updater.quitAndInstall()).resolves.toBeUndefined();
    expect(mocks.prepare).toHaveBeenCalledTimes(2);
    expect(mocks.order).toEqual(["prepare", "prepare", "launch", "quit"]);
  });

  it("installs once even when quitAndInstall is requested twice", async () => {
    const updater = await downloaded();
    const first = updater.quitAndInstall();
    const second = updater.quitAndInstall();
    expect(second).toBe(first);
    await expect(first).resolves.toBeUndefined();
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.quit).toHaveBeenCalledTimes(1);
  });

  it("rejects an archive whose bytes changed after download", async () => {
    const updater = await downloaded();
    await fs.writeFile(destination(), Buffer.alloc(mocks.payload.length, 0x41));
    await expect(updater.quitAndInstall()).rejects.toThrow(
      "Desktop update checksum mismatch",
    );
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
  });

  it("rejects an archive whose size no longer matches the release", async () => {
    const updater = await downloaded();
    await fs.writeFile(destination(), mocks.payload.subarray(1));
    await expect(updater.quitAndInstall()).rejects.toThrow(
      "Desktop update checksum mismatch",
    );
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
  });

  it("refuses to install without a downloaded archive", async () => {
    const updater = new AdHocMacUpdater();
    await expect(updater.quitAndInstall()).rejects.toThrow(
      "请先下载更新安装包。",
    );
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
  });
});
