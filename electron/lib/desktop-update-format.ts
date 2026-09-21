import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

export type DesktopPlatform = "darwin" | "win32";
export type DesktopArch = "arm64" | "x64";
export interface DesktopArtifact {
  name: string;
  size: number;
  sha256: string;
}
export interface DesktopManifest {
  format: 1;
  version: string;
  platform: DesktopPlatform;
  arch: DesktopArch;
  artifact: DesktopArtifact;
  updateArchive?: DesktopArtifact;
  blockMap?: DesktopArtifact;
  signature?: { algorithm: "ed25519"; value: string };
}
export interface DesktopRelease {
  manifest: DesktopManifest;
  url: string;
  notes?: string;
}
export const DESKTOP_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const MAX_BLOCK_MAP_SIZE = 8 * 1024 ** 2;

export function desktopManifestName(platform: string, arch: string): string {
  return `desktop-${platform}-${arch}.json`;
}
export function desktopArtifactName(
  version: string,
  platform: DesktopPlatform,
  arch: DesktopArch,
): string {
  return platform === "darwin"
    ? `Synax-${version}-darwin-${arch}.dmg`
    : `Synax-${version}-full.nupkg`;
}
export function desktopUpdateArtifact(
  manifest: DesktopManifest,
): DesktopArtifact {
  return manifest.updateArchive ?? manifest.artifact;
}
function validArtifact(
  value: DesktopArtifact | undefined,
  name: string,
  max: number,
): boolean {
  return Boolean(
    value &&
    value.name === name &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.size) &&
    value.size > 0 &&
    value.size <= max,
  );
}
export function validateDesktopManifest(value: unknown): DesktopManifest {
  const data = value as DesktopManifest;
  if (
    !data ||
    data.format !== 1 ||
    typeof data.version !== "string" ||
    !DESKTOP_VERSION.test(data.version) ||
    !["darwin", "win32"].includes(data.platform) ||
    !["arm64", "x64"].includes(data.arch) ||
    !validArtifact(
      data.artifact,
      desktopArtifactName(data.version, data.platform, data.arch),
      2 * 1024 ** 3,
    )
  )
    throw new Error("Invalid desktop update manifest");
  if (
    data.updateArchive !== undefined &&
    (data.platform !== "darwin" ||
      !validArtifact(
        data.updateArchive,
        `Synax-${data.version}-darwin-${data.arch}.zip`,
        2 * 1024 ** 3,
      ))
  )
    throw new Error("Invalid desktop update archive metadata");
  if (
    data.blockMap !== undefined &&
    !validArtifact(
      data.blockMap,
      `${desktopUpdateArtifact(data).name}.blockmap`,
      MAX_BLOCK_MAP_SIZE,
    )
  )
    throw new Error("Invalid desktop blockmap metadata");
  if (
    data.signature !== undefined &&
    (!data.signature ||
      data.signature.algorithm !== "ed25519" ||
      typeof data.signature.value !== "string" ||
      !/^[A-Za-z0-9+/]{86}==$/.test(data.signature.value))
  )
    throw new Error("Invalid desktop manifest signature");
  return data;
}
export async function hashFile(
  file: string,
  algorithm = "sha256",
): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export async function verifyDesktopArtifact(
  file: string,
  artifact: DesktopArtifact,
): Promise<boolean> {
  try {
    const stat = await fs.lstat(file);
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size === artifact.size &&
      (await hashFile(file)) === artifact.sha256
    );
  } catch {
    return false;
  }
}
