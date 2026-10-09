import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { frameworkChannel, frameworkUpdateInfo } from "./framework-feed.js";
import type { UpdateInfo } from "electron-updater";

function info(platform = "darwin", arch = "arm64"): UpdateInfo {
  const name = platform === "darwin" ? `Synax-0.2.0-darwin-${arch}.zip` : `Synax-0.2.0-win32-${arch}-NSIS.exe`;
  const url = `https://github.com/coldmint9/Synax/releases/download/v0.2.0/${name}`;
  const sha512 = createHash("sha512").update("installer").digest("base64");
  return { version: "0.2.0", files: [{ url, sha512, size: 9 }], path: url, sha512, releaseDate: new Date(0).toISOString() };
}

it.each(["darwin", "win32"])("pins %s artifact URL and uses the selected proxy for downloads", (platform) => {
  const value = info(platform);
  const result = frameworkUpdateInfo(value, platform, "arm64", "https://proxy.example/");
  expect(result.files[0].url).toBe("https://proxy.example/" + value.files[0].url);
  expect(value.files[0].url).toMatch(/^https:\/\/github.com/);
  expect(frameworkChannel(platform, "arm64")).toBe(`stable-${platform}-arm64`);
});

it.each(["version", "platform", "arch", "host", "hash", "size", "traversal", "multiple", "blockmap", "package"])("rejects mismatched %s metadata", (kind) => {
  const value = info();
  if (kind === "version") value.version = "0.3.0-beta.1";
  if (kind === "platform") value.files[0].url = value.files[0].url.replace("darwin", "win32");
  if (kind === "arch") value.files[0].url = value.files[0].url.replace("arm64", "x64");
  if (kind === "host") value.files[0].url = value.files[0].url.replace("github.com", "example.com");
  if (kind === "hash") value.files[0].sha512 = "broken";
  if (kind === "size") value.files[0].size = -1;
  if (kind === "traversal") value.files[0].url = "../installer.zip";
  if (kind === "multiple") value.files.push(value.files[0]);
  if (kind === "blockmap") value.files[0].blockMapSize = 100;
  if (kind === "package") Object.assign(value, { packages: {} });
  expect(() => frameworkUpdateInfo(value, "darwin", "arm64", null)).toThrow();
});
it("does not activate unsupported platform or architecture", () => {
  expect(() => frameworkChannel("linux", "x64")).toThrow();
  expect(() => frameworkChannel("win32", "ia32")).toThrow();
});
