import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  validateDesktopManifest,
  verifyDesktopArtifact,
  type DesktopManifest,
  type DesktopRelease,
  DESKTOP_VERSION,
  desktopUpdateArtifact,
} from "./desktop-update-format.js";
import { verifyDesktopManifestSignature } from "./desktop-update-signing.js";
import { compareVersions } from "./ui-update-format.js";

export function desktopReleaseDirectory(
  root: string,
  manifest: DesktopManifest,
): string {
  return path.join(
    root,
    `${manifest.version}-${manifest.platform}-${manifest.arch}`,
  );
}

function validateCachedRelease(value: unknown): DesktopRelease {
  const data = value as DesktopRelease;
  const manifest = validateDesktopManifest(data?.manifest);
  verifyDesktopManifestSignature(manifest);
  const url = `https://github.com/coldmint9/Synax/releases/download/v${manifest.version}/${desktopUpdateArtifact(manifest).name}`;
  if (data.url !== url) throw new Error("Invalid cached desktop release URL");
  return {
    manifest,
    url,
    notes: typeof data.notes === "string" ? data.notes.slice(0, 20_000) : "",
  };
}

export async function cacheDesktopRelease(
  root: string,
  release: DesktopRelease,
): Promise<void> {
  const value = validateCachedRelease(release);
  const directory = desktopReleaseDirectory(root, value.manifest);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, "release.json");
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function forgetCachedDesktopRelease(
  root: string,
  release: DesktopRelease,
): Promise<void> {
  await fs.rm(
    path.join(desktopReleaseDirectory(root, release.manifest), "release.json"),
    { force: true },
  );
}

export async function findCachedDesktopBase(
  root: string,
  version: string,
  platform: string,
  arch: string,
): Promise<{ release: DesktopRelease; file: string } | null> {
  if (
    !DESKTOP_VERSION.test(version) ||
    !["darwin", "win32"].includes(platform) ||
    !["arm64", "x64"].includes(arch)
  )
    return null;
  const directory = path.join(root, `${version}-${platform}-${arch}`);
  try {
    if (!(await fs.lstat(directory)).isDirectory()) return null;
    const metadata = path.join(directory, "release.json");
    const stat = await fs.lstat(metadata);
    if (!stat.isFile() || stat.size > 100_000) return null;
    const release = validateCachedRelease(
      JSON.parse(await fs.readFile(metadata, "utf8")),
    );
    if (
      !release.manifest.blockMap ||
      desktopReleaseDirectory(root, release.manifest) !== directory
    )
      return null;
    const artifact = desktopUpdateArtifact(release.manifest);
    const file = path.join(directory, artifact.name);
    if (await verifyDesktopArtifact(file, artifact)) return { release, file };
  } catch {
    /* Missing, unsigned or damaged bases use the complete package instead. */
  }
  return null;
}

export async function findCachedDesktopRelease(
  root: string,
  currentVersion: string,
  platform: string,
  arch: string,
  verify = verifyDesktopArtifact,
  onVerifying: (release: DesktopRelease) => void = () => {},
): Promise<{ release: DesktopRelease; file: string } | null> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const candidates = entries
    .filter((entry) => {
      const match = /^(\d+\.\d+\.\d+)-(darwin|win32)-(arm64|x64)$/.exec(
        entry.name,
      );
      return (
        entry.isDirectory() &&
        match &&
        match[2] === platform &&
        match[3] === arch &&
        compareVersions(match[1], currentVersion) > 0
      );
    })
    .sort((a, b) =>
      compareVersions(b.name.split("-")[0], a.name.split("-")[0]),
    );
  for (const entry of candidates) {
    try {
      const directory = path.join(root, entry.name);
      const metadata = path.join(directory, "release.json");
      const stat = await fs.lstat(metadata);
      if (!stat.isFile() || stat.size > 100_000) continue;
      const release = validateCachedRelease(
        JSON.parse(await fs.readFile(metadata, "utf8")),
      );
      if (desktopReleaseDirectory(root, release.manifest) !== directory)
        continue;
      const artifact = desktopUpdateArtifact(release.manifest);
      const file = path.join(directory, artifact.name);
      onVerifying(release);
      if (await verify(file, artifact)) return { release, file };
    } catch {
      // Incomplete downloads or damaged metadata must never become installable.
    }
  }
  return null;
}
