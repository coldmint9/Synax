import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createDesktopReleaseArtifacts } from "./desktop-release-artifacts.js";
import { sha256 } from "../electron/lib/ui-update-format.js";
import { verifyDesktopManifestSignature } from "../electron/lib/desktop-update-signing.js";
let root: string;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});
it("signs generated archive and blockmap metadata with the configured release key", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-signed-release-"));
  const make = path.join(root, "make");
  await fs.mkdir(make);
  await fs.writeFile(path.join(make, "Synax-0.2.0-full.nupkg"), "full package");
  const pair = generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const publicKey = pair.publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  const manifest = await createDesktopReleaseArtifacts(
    make,
    path.join(root, "release"),
    "0.2.0",
    "win32",
    "x64",
    { privateKey, publicKey },
  );
  expect(manifest.blockMap).toBeDefined();
  expect(verifyDesktopManifestSignature(manifest, publicKey)).toBe(true);
  expect(JSON.stringify(manifest)).not.toContain(privateKey);
});
it.each(["darwin", "win32"] as const)(
  "produces matching release metadata for %s",
  async (platform) => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-desktop-release-"));
    const make = path.join(root, "make");
    const output = path.join(root, "updates");
    await fs.mkdir(make);
    const source =
      platform === "darwin"
        ? "Synax-0.2.0-darwin-arm64.dmg"
        : "Synax-0.2.0-full.nupkg";
    const bytes = Buffer.from("desktop release package");
    await fs.writeFile(path.join(make, source), bytes);
    const updateName =
      platform === "darwin" ? "Synax-0.2.0-darwin-arm64.zip" : source;
    if (platform === "darwin")
      await fs.writeFile(path.join(make, updateName), bytes);
    const manifest = await createDesktopReleaseArtifacts(
      make,
      output,
      "0.2.0",
      platform,
      "arm64",
    );
    expect(manifest.artifact.sha256).toBe(sha256(bytes));
    expect(manifest.artifact.size).toBe(bytes.length);
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(output, `desktop-${platform}-arm64.json`),
          "utf8",
        ),
      ),
    ).toEqual(manifest);
    expect(await fs.readFile(path.join(make, manifest.artifact.name))).toEqual(
      bytes,
    );
    expect(manifest.blockMap?.name).toBe(`${updateName}.blockmap`);
    if (platform === "darwin")
      expect(manifest.updateArchive?.sha256).toBe(sha256(bytes));
    const blockMap = await fs.readFile(
      path.join(output, manifest.blockMap!.name),
    );
    expect(sha256(blockMap)).toBe(manifest.blockMap!.sha256);
    expect((await fs.readdir(output)).sort()).toEqual(
      [`${updateName}.blockmap`, `desktop-${platform}-arm64.json`].sort(),
    );
    await expect(
      createDesktopReleaseArtifacts(make, output, "0.3.0", platform, "arm64"),
    ).rejects.toThrow("Expected one");
  },
);
