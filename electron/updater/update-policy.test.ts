import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { UpdaterController } from "./controller.js";
import { effectiveUpdateSource } from "./effective-update-source.js";
import { packagedUpdateConfig } from "./update-source.js";
import {
  DEFAULT_UPDATE_SETTINGS,
  configureUpdateSettings,
} from "./update-settings.js";
import { ONLINE_UPDATES_DISABLED_MESSAGE } from "./update-policy.js";

const source = "https://updates.example/synax/";

afterEach(() => {
  configureUpdateSettings({ ...DEFAULT_UPDATE_SETTINGS });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("builds offline installers when the build injects no source", () => {
  for (const value of [undefined, "", " "]) {
    const config = packagedUpdateConfig(
      { SYNAX_FRAMEWORK_UPDATE_URL: value },
      "darwin",
      "arm64",
    );
    expect(config).toMatchObject({ disabled: true, productName: "Synax" });
    expect(config).not.toHaveProperty("url");
  }
  expect(
    packagedUpdateConfig({ SYNAX_FRAMEWORK_UPDATE_URL: source }, "win32", "x64"),
  ).toMatchObject({ disabled: false, url: source });
});

it("keeps online updates off until the user enables them", () => {
  const env = { SYNAX_FRAMEWORK_UPDATE_URL: source };
  const readConfig = vi.fn(() => JSON.stringify(packagedUpdateConfig(env, "darwin", "arm64")));
  expect(() =>
    effectiveUpdateSource({ env: {}, resourcesPath: "/resources", readConfig }),
  ).toThrow(ONLINE_UPDATES_DISABLED_MESSAGE);
  expect(readConfig).not.toHaveBeenCalled();
});

it("uses the user-configured source once updates are enabled", () => {
  configureUpdateSettings({
    ...DEFAULT_UPDATE_SETTINGS,
    enabled: true,
    sourceUrl: "https://user-updates.example/synax",
  });
  const readConfig = vi.fn(() => {
    throw new Error("must not read");
  });
  expect(
    effectiveUpdateSource({ env: {}, resourcesPath: "/resources", readConfig }),
  ).toBe("https://user-updates.example/synax/");
  expect(readConfig).not.toHaveBeenCalled();
});

it("falls back to the build-time source when the user leaves it empty", () => {
  configureUpdateSettings({ ...DEFAULT_UPDATE_SETTINGS, enabled: true });
  const env = { SYNAX_FRAMEWORK_UPDATE_URL: source };
  expect(effectiveUpdateSource({ env: {}, resourcesPath: "/resources", readConfig: () => JSON.stringify(packagedUpdateConfig(env, "darwin", "arm64")) }))
    .toBe(source);
});

it("does not restore cached installers or run the engine while updates are paused", async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "synax-updates-disabled-"));
  const directory = path.join(profile, "desktop-updates");
  const cache = path.join(directory, "framework-ready.json");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("SYNAX_FRAMEWORK_UPDATE_URL", source);
  const dependencies = {
    resolveSource: vi.fn(() => source),
    create: vi.fn(), configure: vi.fn(), eligible: vi.fn(), verifyInstaller: vi.fn(),
  };
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await fs.mkdir(directory);
    await fs.writeFile(cache, "cached installer from a previous release");
    const value = new UpdaterController({
      currentVersion: "0.2.0", uiVersion: null, executable: "/app/Synax.exe",
      profile, parentPid: process.pid,
    }, () => {}, dependencies);
    await value.initialize();
    await value.check();
    await value.download();
    await value.install();
    expect(value.snapshot()).toMatchObject({
      phase: "error", availableVersion: null, message: ONLINE_UPDATES_DISABLED_MESSAGE,
    });
    for (const dependency of Object.values(dependencies)) expect(dependency).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(await fs.readFile(cache, "utf8")).toBe("cached installer from a previous release");
  } finally {
    log.mockRestore();
    await fs.rm(profile, { recursive: true, force: true });
  }
});
