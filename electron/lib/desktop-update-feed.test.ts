import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sha256 } from "./ui-update-format.js";
import { desktopArtifactName, downloadDesktopRelease, findDesktopRelease, validateDesktopManifest, type DesktopManifest } from "./desktop-update-feed.js";

const bytes = Buffer.from("full desktop bundle");
const manifest: DesktopManifest = {
  format: 1, version: "0.2.0", platform: "darwin", arch: "arm64",
  artifact: { name: desktopArtifactName("0.2.0", "darwin", "arm64"), size: bytes.length, sha256: sha256(bytes) },
};
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it.each([undefined, "https://updates.example/synax/"])("keeps the legacy desktop protocol unavailable with framework source %s", async (source) => {
  vi.stubEnv("SYNAX_FRAMEWORK_UPDATE_URL", source);
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synax-disabled-update-"));
  try {
    // Even a checksum-valid legacy cache must not bypass the source gate.
    await fs.writeFile(path.join(directory, manifest.artifact.name), bytes);
    await expect(findDesktopRelease("0.1.2", "darwin", "arm64")).rejects.toThrow("不可用");
    await expect(downloadDesktopRelease({ manifest, url: "https://github.com/coldmint9/Synax/releases" }, directory)).rejects.toThrow("不可用");
    expect(fetch).not.toHaveBeenCalled();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
it.each([
  { ...manifest, artifact: { ...manifest.artifact, name: "../Synax.app" } },
  { ...manifest, artifact: { ...manifest.artifact, name: "Synax-0.2.0-darwin-arm64.dmg" } },
  { ...manifest, artifact: { ...manifest.artifact, size: 3 * 1024 ** 3 } },
  { ...manifest, artifact: { ...manifest.artifact, sha256: "bad" } },
  { ...manifest, arch: "other" },
])("rejects invalid or upstream manifest %#", (value) => expect(() => validateDesktopManifest(value)).toThrow("manifest"));
