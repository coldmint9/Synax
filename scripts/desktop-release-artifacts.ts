import fs from "node:fs/promises";
import path from "node:path";
import {
  desktopArtifactName,
  desktopManifestName,
  hashFile,
  validateDesktopManifest,
  type DesktopArch,
  type DesktopPlatform,
  type DesktopManifest,
} from "../electron/lib/desktop-update-format.js";
import { createDesktopBlockMap } from "./desktop-blockmap.js";
import { signDesktopManifest } from "../electron/lib/desktop-update-signing.js";

export async function createDesktopReleaseArtifacts(
  makeDirectory: string,
  output: string,
  version: string,
  platform: DesktopPlatform,
  arch: DesktopArch,
  signing?: { privateKey: string; publicKey: string },
): Promise<DesktopManifest> {
  const sourceName = desktopArtifactName(version, platform, arch);
  const updateName =
    platform === "darwin" ? `Synax-${version}-darwin-${arch}.zip` : sourceName;
  const candidates: string[] = [];
  const updateCandidates: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        if (entry.name === sourceName) candidates.push(file);
        if (entry.name === updateName) updateCandidates.push(file);
      }
    }
  }
  await visit(makeDirectory);
  if (candidates.length !== 1)
    throw new Error(`Expected one ${sourceName}, found ${candidates.length}`);
  const source = candidates[0];
  if (updateCandidates.length !== 1)
    throw new Error(
      `Expected one ${updateName}, found ${updateCandidates.length}`,
    );
  const updateSource = updateCandidates[0];
  let manifest = validateDesktopManifest({
    format: 1,
    version,
    platform,
    arch,
    artifact: {
      name: desktopArtifactName(version, platform, arch),
      size: (await fs.stat(source)).size,
      sha256: await hashFile(source),
    },
  });
  await fs.mkdir(output, { recursive: true });
  if (platform === "darwin")
    manifest.updateArchive = {
      name: updateName,
      size: (await fs.stat(updateSource)).size,
      sha256: await hashFile(updateSource),
    };
  manifest.blockMap = await createDesktopBlockMap(
    updateSource,
    path.join(output, `${updateName}.blockmap`),
  );
  validateDesktopManifest(manifest);
  if (signing)
    manifest = signDesktopManifest(
      manifest,
      signing.privateKey,
      signing.publicKey,
    );
  // Forge already emits the canonical artifact name. Publish only metadata here
  // so GitHub never receives two assets with the same filename.
  await fs.writeFile(
    path.join(output, desktopManifestName(platform, arch)),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}
