import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  desktopDownloadName,
  desktopIcon,
  desktopProduct,
  normalizeDesktopArtifacts,
  updaterMacInfo,
  windowsMetadata,
} from "./desktop-branding.js";
import { desktopArtifactName } from "../electron/lib/desktop-update-feed.js";

let root: string;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});
describe("Synax desktop branding", () => {
  it("keeps versioned download names compatible with the updater", () => {
    for (const arch of ["arm64", "x64"] as const)
      expect(desktopDownloadName("0.2.0", "darwin", arch, "dmg")).toBe(
        desktopArtifactName("0.2.0", "darwin", arch),
      );
    expect(desktopDownloadName("0.2.0", "win32", "x64", "exe")).toBe(
      "Synax-0.2.0-win32-x64-Setup.exe",
    );
    expect(desktopDownloadName("0.2.0", "linux", "x64", "zip")).toBe(
      "Synax-0.2.0-linux-x64.zip",
    );
  });
  it("uses the product identity in Windows executable metadata", () => {
    expect(windowsMetadata()).toMatchObject({
      ProductName: "Synax",
      FileDescription: desktopProduct.description,
      OriginalFilename: "Synax.exe",
    });
    expect(desktopProduct.description).toBe("Local-first AI coding workspace");
  });
  it("keeps the macOS updater out of the Dock while preserving its window", () => {
    expect(updaterMacInfo("darwin")).toEqual({ LSUIElement: true });
    expect(updaterMacInfo("win32")).toBeUndefined();
  });
  it("includes a real Windows ICO with small and large icons", async () => {
    const bytes = await fs.readFile(desktopIcon("win32"));
    expect(bytes.readUInt16LE(0)).toBe(0);
    expect(bytes.readUInt16LE(2)).toBe(1);
    const sizes = [];
    for (let i = 0; i < bytes.readUInt16LE(4); i++) {
      const entry = 6 + 16 * i;
      sizes.push(bytes[entry] || 256);
      const size = bytes.readUInt32LE(entry + 8),
        offset = bytes.readUInt32LE(entry + 12);
      expect(offset + size).toBeLessThanOrEqual(bytes.length);
      expect(size).toBeGreaterThan(0);
    }
    expect(sizes).toEqual(
      expect.arrayContaining([16, 24, 32, 48, 64, 128, 256]),
    );
  });
  it("normalizes ZIP and installer artifacts without changing Squirrel feed filenames", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-branding-"));
    const names = [
      "Synax-win32-x64-0.2.0.zip",
      "Synax-0.2.0 Setup.exe",
      "Synax-0.2.0-full.nupkg",
      "RELEASES",
    ];
    for (const name of names) await fs.writeFile(path.join(root, name), name);
    const [result] = await normalizeDesktopArtifacts([
      {
        artifacts: names.map((name) => path.join(root, name)),
        packageJSON: { version: "0.2.0" },
        platform: "win32",
        arch: "x64",
      },
    ]);
    expect(result.artifacts.map((file) => path.basename(file))).toEqual([
      "Synax-0.2.0-win32-x64.zip",
      "Synax-0.2.0-win32-x64-Setup.exe",
      "Synax-0.2.0-full.nupkg",
      "RELEASES",
    ]);
    expect(await fs.readFile(result.artifacts[0], "utf8")).toBe(names[0]);
    expect(await fs.readFile(result.artifacts[1], "utf8")).toBe(names[1]);
  });
});
