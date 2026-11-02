import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { effectiveUpdateSource } from "./effective-update-source.js";
import { packagedUpdateConfig, resolveUpdateSource } from "./update-source.js";
import { frameworkUpdateInfo } from "./framework-feed.js";
import {
  DEFAULT_UPDATE_SETTINGS,
  configureUpdateSettings,
} from "./update-settings.js";

const source = "https://updates.example/synax/";
const packaged = () => packagedUpdateConfig({ SYNAX_FRAMEWORK_UPDATE_URL: source }, "darwin", "arm64");
beforeEach(() =>
  configureUpdateSettings({ ...DEFAULT_UPDATE_SETTINGS, enabled: true }),
);
afterEach(() => {
  configureUpdateSettings({ ...DEFAULT_UPDATE_SETTINGS });
  vi.unstubAllEnvs();
});

it("builds offline installers when CI injects an unset repository variable", () => {
  expect(packagedUpdateConfig({ SYNAX_FRAMEWORK_UPDATE_URL: "" }, "win32", "x64"))
    .toMatchObject({ disabled: true, productName: "Synax" });
  expect(packagedUpdateConfig({ SYNAX_FRAMEWORK_UPDATE_URL: " " }, "win32", "x64"))
    .not.toHaveProperty("url");
});

it("reads a build-time source from packaged resources without any launch environment", async () => {
  const resourcesPath = await fs.mkdtemp(path.join(os.tmpdir(), "synax-packaged-source-"));
  try {
    await fs.writeFile(path.join(resourcesPath, "app-update.yml"), JSON.stringify(packaged()));
    expect(effectiveUpdateSource({ env: {}, resourcesPath })).toBe(source);
    const resolve = () => effectiveUpdateSource({ env: {}, resourcesPath });
    const url = source + "Synax-0.2.0-darwin-arm64.dmg";
    expect(frameworkUpdateInfo({
      ...packaged(), version: "0.2.0", path: url, sha512: "a".repeat(86) + "==", releaseDate: "",
      files: [{ url, sha512: "a".repeat(86) + "==", size: 1 }],
    }, "darwin", "arm64", null, resolve).files[0].url).toBe(url);
  } finally { await fs.rm(resourcesPath, { recursive: true, force: true }); }
});
it("honors a valid explicit override without reading the packaged file", () => {
  const readConfig = vi.fn(() => { throw new Error("must not read"); });
  expect(effectiveUpdateSource({ env: { SYNAX_FRAMEWORK_UPDATE_URL: "https://override.example/synax" }, resourcesPath: "/resources", readConfig }))
    .toBe("https://override.example/synax/");
  expect(readConfig).not.toHaveBeenCalled();
});
it.each(["", " ", "not a URL", "http://unsafe.example/", "https://github.com/coldmint9/Synax/releases/latest/download/"])("never falls back from explicit invalid override %j", (value) => {
  const readConfig = vi.fn(() => JSON.stringify(packaged()));
  expect(() => effectiveUpdateSource({ env: { SYNAX_FRAMEWORK_UPDATE_URL: value }, resourcesPath: "/resources", readConfig })).toThrow();
  expect(readConfig).not.toHaveBeenCalled();
});
it.each([
  undefined,
  { ...packaged(), productName: "Synax" },
  { ...packaged(), bundleId: "com.Synax.desktop" },
  { ...packaged(), disabled: undefined },
  { ...packaged(), provider: "github" },
  { ...packaged(), url: "http://unsafe.example/" },
  packagedUpdateConfig({}, "darwin", "arm64"),
])("rejects missing, disabled or foreign packaged configuration %#", (config) => {
  expect(() => resolveUpdateSource({}, config)).toThrow();
});
it("fails closed on corrupt packaged data without searching profile or cwd", () => {
  const readConfig = vi.fn(() => "invalid YAML/JSON");
  expect(() => effectiveUpdateSource({ env: {}, resourcesPath: "/resources", readConfig })).toThrow("配置");
  expect(readConfig).toHaveBeenCalledExactlyOnceWith(path.join("/resources", "app-update.yml"));
});

