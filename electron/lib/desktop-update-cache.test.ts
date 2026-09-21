import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  cacheDesktopRelease,
  desktopReleaseDirectory,
  findCachedDesktopRelease,
} from "./desktop-update-cache.js";
import {
  desktopArtifactName,
  type DesktopRelease,
} from "./desktop-update-feed.js";
import { sha256 } from "./ui-update-format.js";

let root: string;
const bytes = Buffer.from("verified cached package");
function release(version: string): DesktopRelease {
  const name = desktopArtifactName(version, "darwin", "arm64");
  return {
    manifest: {
      format: 1,
      version,
      platform: "darwin",
      arch: "arm64",
      artifact: { name, size: bytes.length, sha256: sha256(bytes) },
    },
    url: `https://github.com/coldmint9/Synax/releases/download/v${version}/${name}`,
    notes: "Release notes",
  };
}
async function save(value: DesktopRelease) {
  const directory = desktopReleaseDirectory(root, value.manifest);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, value.manifest.artifact.name);
  await fs.writeFile(file, bytes);
  await cacheDesktopRelease(root, value);
  return { directory, file, metadata: path.join(directory, "release.json") };
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-cache-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

it("restores the newest verified version for the exact platform without a network request", async () => {
  await save(release("0.2.0"));
  const newest = release("0.3.0");
  const { directory, file } = await save(newest);
  expect(
    await findCachedDesktopRelease(root, "0.1.0", "darwin", "arm64"),
  ).toEqual({ release: newest, file });
  expect(
    await findCachedDesktopRelease(root, "0.3.0", "darwin", "arm64"),
  ).toBeNull();
  expect(
    await findCachedDesktopRelease(root, "0.1.0", "darwin", "x64"),
  ).toBeNull();
  expect(
    await findCachedDesktopRelease(root, "0.1.0", "win32", "arm64"),
  ).toBeNull();
  expect((await fs.readdir(directory)).sort()).toEqual(
    [newest.manifest.artifact.name, "release.json"].sort(),
  );
});
it("restores the update ZIP instead of requiring the legacy DMG to be cached", async () => {
  const value = release("0.2.0");
  const name = "Synax-0.2.0-darwin-arm64.zip";
  value.manifest.updateArchive = {
    name,
    size: bytes.length,
    sha256: sha256(bytes),
  };
  value.url = `https://github.com/coldmint9/Synax/releases/download/v0.2.0/${name}`;
  await cacheDesktopRelease(root, value);
  const file = path.join(desktopReleaseDirectory(root, value.manifest), name);
  await fs.writeFile(file, bytes);
  expect(
    await findCachedDesktopRelease(root, "0.1.0", "darwin", "arm64"),
  ).toEqual({ release: value, file });
});

it("skips a damaged newer package and keeps the older verified cache", async () => {
  const older = await save(release("0.2.0"));
  const newest = await save(release("0.3.0"));
  await fs.writeFile(newest.file, Buffer.alloc(bytes.length));
  expect(
    (await findCachedDesktopRelease(root, "0.1.0", "darwin", "arm64"))?.file,
  ).toBe(older.file);
});

it.each([
  "missing",
  "truncated",
  "corrupt",
  "partial",
  "bad-json",
  "wrong-directory",
  "untrusted-url",
])("never restores a %s cache", async (kind) => {
  const value = release("0.2.0");
  const { file, metadata, directory } = await save(value);
  if (kind === "missing") await fs.rm(file);
  if (kind === "truncated") await fs.writeFile(file, bytes.subarray(0, 2));
  if (kind === "corrupt") await fs.writeFile(file, Buffer.alloc(bytes.length));
  if (kind === "partial") await fs.rename(file, `${file}.part`);
  if (kind === "bad-json") await fs.writeFile(metadata, "broken");
  if (kind === "wrong-directory")
    await fs.rename(directory, path.join(root, "0.9.0-darwin-arm64"));
  if (kind === "untrusted-url")
    await fs.writeFile(
      metadata,
      JSON.stringify({ ...value, url: "https://evil.example/update" }),
    );
  expect(
    await findCachedDesktopRelease(root, "0.1.0", "darwin", "arm64"),
  ).toBeNull();
});

it.skipIf(process.platform === "win32")(
  "does not follow symlinked metadata or package files",
  async () => {
    const { file, metadata } = await save(release("0.2.0"));
    await fs.rename(file, `${file}.original`);
    await fs.symlink(`${file}.original`, file);
    expect(
      await findCachedDesktopRelease(root, "0.1.0", "darwin", "arm64"),
    ).toBeNull();
    await fs.rm(file);
    await fs.rename(`${file}.original`, file);
    await fs.rename(metadata, `${metadata}.original`);
    await fs.symlink(`${metadata}.original`, metadata);
    expect(
      await findCachedDesktopRelease(root, "0.1.0", "darwin", "arm64"),
    ).toBeNull();
  },
);
