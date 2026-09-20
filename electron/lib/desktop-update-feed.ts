import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { compareVersions } from "./ui-update-format.js";
import {
  fetchGithubResponse,
  fetchLimited,
  type Release,
} from "./ui-update-feed.js";

export type DesktopPlatform = "darwin" | "win32";
export type DesktopArch = "arm64" | "x64";
export interface DesktopManifest {
  format: 1;
  version: string;
  platform: DesktopPlatform;
  arch: DesktopArch;
  artifact: { name: string; size: number; sha256: string };
}
export interface DesktopRelease {
  manifest: DesktopManifest;
  url: string;
  notes?: string;
}
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

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

export function validateDesktopManifest(value: unknown): DesktopManifest {
  const data = value as DesktopManifest;
  if (
    !data ||
    data.format !== 1 ||
    typeof data.version !== "string" ||
    !VERSION.test(data.version) ||
    !["darwin", "win32"].includes(data.platform) ||
    !["arm64", "x64"].includes(data.arch) ||
    !data.artifact ||
    data.artifact.name !==
      desktopArtifactName(data.version, data.platform, data.arch) ||
    typeof data.artifact.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.artifact.sha256) ||
    !Number.isSafeInteger(data.artifact.size) ||
    data.artifact.size <= 0 ||
    data.artifact.size > 2 * 1024 ** 3
  ) {
    throw new Error("Invalid desktop update manifest");
  }
  return data;
}

export async function findDesktopRelease(
  current: string,
  platform: DesktopPlatform,
  arch: DesktopArch,
): Promise<DesktopRelease | null> {
  if (!VERSION.test(current)) return null;
  const releases: Release[] = [];
  for (let page = 1; page <= 5; page++) {
    const batch = JSON.parse(
      (
        await fetchLimited(
          `https://api.github.com/repos/coldmint9/Synax/releases?per_page=100&page=${page}`,
          5_000_000,
        )
      ).toString("utf8"),
    );
    if (!Array.isArray(batch))
      throw new Error("Invalid GitHub release listing");
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  const candidates = releases.filter(
    (release) =>
      !release.draft &&
      !release.prerelease &&
      typeof release.tag_name === "string" &&
      release.tag_name.startsWith("v") &&
      VERSION.test(release.tag_name.slice(1)) &&
      compareVersions(release.tag_name.slice(1), current) > 0,
  );
  candidates.sort((a, b) =>
    compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)),
  );
  for (const release of candidates) {
    const asset = release.assets?.find(
      (item) => item.name === desktopManifestName(platform, arch),
    );
    // Older releases and platforms still being built have no update manifest.
    if (!asset) continue;
    const manifest = validateDesktopManifest(
      JSON.parse(
        (await fetchLimited(asset.browser_download_url, 100_000)).toString(
          "utf8",
        ),
      ),
    );
    if (
      manifest.version !== release.tag_name.slice(1) ||
      manifest.platform !== platform ||
      manifest.arch !== arch
    )
      throw new Error("Desktop update does not match its release or platform");
    const artifact = release.assets.find(
      (item) => item.name === manifest.artifact.name,
    );
    if (artifact)
      return {
        manifest,
        url: artifact.browser_download_url,
        notes:
          typeof release.body === "string" ? release.body.slice(0, 20_000) : "",
      };
  }
  return null;
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
  artifact: DesktopManifest["artifact"],
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

export async function downloadDesktopRelease(
  release: DesktopRelease,
  directory: string,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const { artifact } = validateDesktopManifest(release.manifest);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, artifact.name);
  if (await verifyDesktopArtifact(file, artifact)) return file;
  const temporary = `${file}.${randomUUID()}.part`;
  try {
    const response = await fetchGithubResponse(release.url, 30 * 60_000);
    const reader = response.body!.getReader();
    const handle = await fs.open(temporary, "wx", 0o600);
    let size = 0;
    const hash = createHash("sha256");
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > artifact.size)
          throw new Error("Desktop update exceeds size limit");
        hash.update(value);
        await handle.writeFile(value);
        onProgress?.(size / artifact.size);
      }
      if (size !== artifact.size || hash.digest("hex") !== artifact.sha256)
        throw new Error("Desktop update checksum mismatch");
      await handle.sync();
    } finally {
      await reader.cancel().catch(() => {});
      await handle.close();
    }
    await fs.rm(file, { force: true });
    await fs.rename(temporary, file);
    return file;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
