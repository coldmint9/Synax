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
} from "../electron/lib/desktop-update-feed.js";

export async function createDesktopReleaseArtifacts(
  makeDirectory: string,
  output: string,
  version: string,
  platform: DesktopPlatform,
  arch: DesktopArch,
): Promise<DesktopManifest> {
  const sourceName =
    platform === "darwin"
      ? `Synax-${version}-${arch}.dmg`
      : `Synax-${version}-full.nupkg`;
  const candidates: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name === sourceName)
        candidates.push(file);
    }
  }
  await visit(makeDirectory);
  if (candidates.length !== 1)
    throw new Error(`Expected one ${sourceName}, found ${candidates.length}`);
  const source = candidates[0];
  const manifest = validateDesktopManifest({
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
  // The Windows package is already published by Forge under its required name.
  if (platform === "darwin")
    await fs.copyFile(source, path.join(output, manifest.artifact.name));
  await fs.writeFile(
    path.join(output, desktopManifestName(platform, arch)),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}
