import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { frameworkChannel, frameworkUpdateInfo } from "./framework-feed.js";
import { frameworkFeedUrl } from "./update-source.js";
import {
  DEFAULT_UPDATE_SETTINGS,
  configureUpdateSettings,
} from "./update-settings.js";
import type { UpdateInfo } from "electron-updater";

beforeEach(() => {
  configureUpdateSettings({ ...DEFAULT_UPDATE_SETTINGS, enabled: true });
  vi.stubEnv("SYNAX_FRAMEWORK_UPDATE_URL", "https://updates.example/synax/");
});
afterEach(() => {
  configureUpdateSettings({ ...DEFAULT_UPDATE_SETTINGS });
  vi.unstubAllEnvs();
});
function info(platform = "darwin", arch = "arm64"): UpdateInfo {
  const name = platform === "darwin" ? `Synax-0.2.0-darwin-${arch}.dmg` : `Synax-0.2.0-win32-${arch}-NSIS.exe`;
  const url = `https://updates.example/synax/${name}`;
  const sha512 = createHash("sha512").update("installer").digest("base64");
  return Object.assign({ version: "0.2.0", files: [{ url, sha512, size: 9 }], path: url, sha512, releaseDate: new Date(0).toISOString() },
    { productName: "Synax", bundleId: "com.Synax.desktop" });
}
it.each(["darwin", "win32"])("pins %s enterprise artifacts without a public GitHub proxy", (platform) => {
  const value = info(platform);
  expect(frameworkUpdateInfo(value, platform, "arm64", "https://gh-proxy.org/").files[0].url).toBe(value.files[0].url);
  expect(frameworkChannel(platform, "arm64")).toBe(`stable-${platform}-arm64`);
});
it('rejects a ZIP-only macOS feed', () => {
  const value = info();
  value.files[0].url = value.files[0].url.replace('.dmg', '.zip');
  expect(() => frameworkUpdateInfo(value, 'darwin', 'arm64', null)).toThrow('不匹配');
});
it.each(["version", "platform", "arch", "host", "hash", "size", "traversal", "multiple", "blockmap", "package", "product", "bundle", "upstream", "missing-identity"])("rejects mismatched %s metadata", (kind) => {
  const value = info();
  if (kind === "version") value.version = "0.3.0-beta.1";
  if (kind === "platform") value.files[0].url = value.files[0].url.replace("darwin", "win32");
  if (kind === "arch") value.files[0].url = value.files[0].url.replace("arm64", "x64");
  if (kind === "host") value.files[0].url = value.files[0].url.replace("updates.example", "evil.example");
  if (kind === "hash") value.files[0].sha512 = "broken";
  if (kind === "size") value.files[0].size = -1;
  if (kind === "traversal") value.files[0].url = "../installer.zip";
  if (kind === "multiple") value.files.push(value.files[0]);
  if (kind === "blockmap") value.files[0].blockMapSize = 100;
  if (kind === "package") Object.assign(value, { packages: {} });
  if (kind === "product") Object.assign(value, { productName: "Synax" });
  if (kind === "bundle") Object.assign(value, { bundleId: "com.Synax.desktop" });
  if (kind === "upstream") value.files[0].url = "https://github.com/coldmint9/Synax/releases/download/v0.2.0/Synax.zip";
  if (kind === "missing-identity") Reflect.deleteProperty(value, "bundleId");
  expect(() => frameworkUpdateInfo(value, "darwin", "arm64", null)).toThrow();
});
it.each([undefined, "", "http://updates.example/", "https://user:pass@updates.example/", "https://updates.example/?token=secret", "https://github.com/coldmint9/Synax/releases/latest/download/"])("fails closed for unconfigured or unsafe source %s", (source) => {
  vi.stubEnv("SYNAX_FRAMEWORK_UPDATE_URL", source);
  expect(() => frameworkFeedUrl(process.env)).toThrow();
  expect(() => frameworkUpdateInfo(info(), "darwin", "arm64", null)).toThrow();
});
it("rejects unsupported platform or architecture", () => {
  expect(() => frameworkChannel("linux", "x64")).toThrow();
  expect(() => frameworkChannel("win32", "ia32")).toThrow();
});

