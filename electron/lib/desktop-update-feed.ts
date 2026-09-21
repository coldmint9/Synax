import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { compareVersions } from "./ui-update-format.js";
import {
  fetchGithubResponse,
  fetchLimited,
  type Release,
} from "./ui-update-feed.js";
import {
  DESKTOP_VERSION as VERSION,
  desktopManifestName,
  validateDesktopManifest,
  verifyDesktopArtifact,
  desktopUpdateArtifact,
  type DesktopPlatform,
  type DesktopArch,
  type DesktopRelease,
} from "./desktop-update-format.js";
import { verifyDesktopManifestSignature } from "./desktop-update-signing.js";
import { findCachedDesktopBase } from "./desktop-update-cache.js";
import { downloadDesktopDifferential } from "./desktop-differential.js";
import type { DesktopTransfer } from "../updater/contract.js";
export {
  desktopArtifactName,
  desktopUpdateArtifact,
  desktopManifestName,
  validateDesktopManifest,
  verifyDesktopArtifact,
  hashFile,
  type DesktopPlatform,
  type DesktopArch,
  type DesktopManifest,
  type DesktopRelease,
} from "./desktop-update-format.js";

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
    verifyDesktopManifestSignature(manifest);
    const artifact = release.assets.find(
      (item) => item.name === desktopUpdateArtifact(manifest).name,
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

export async function downloadDesktopRelease(
  release: DesktopRelease,
  directory: string,
  onProgress?: (fraction: number) => void,
  onVerifying?: () => void,
  options?: {
    currentVersion: string;
    onTransfer?: (transfer: DesktopTransfer) => void;
  },
): Promise<string> {
  const artifact = desktopUpdateArtifact(
    validateDesktopManifest(release.manifest),
  );
  const trusted = verifyDesktopManifestSignature(release.manifest);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, artifact.name);
  if (await verifyDesktopArtifact(file, artifact)) {
    onVerifying?.();
    return file;
  }
  const temporary = `${file}.${randomUUID()}.part`;
  try {
    let fallback = false;
    if (
      trusted &&
      release.manifest.blockMap &&
      options?.currentVersion &&
      VERSION.test(options.currentVersion) &&
      compareVersions(options.currentVersion, release.manifest.version) < 0
    ) {
      try {
        const base = await findCachedDesktopBase(
          path.dirname(directory),
          options.currentVersion,
          release.manifest.platform,
          release.manifest.arch,
        );
        if (
          base &&
          (await downloadDesktopDifferential(
            release,
            base,
            temporary,
            onProgress,
            onVerifying,
            options.onTransfer,
          ))
        ) {
          await fs.rm(file, { force: true });
          await fs.rename(temporary, file);
          return file;
        }
      } catch (error) {
        fallback = true;
        console.warn(
          "[desktop-update] Differential download failed; using full package:",
          error instanceof Error ? error.message : String(error),
        );
        await fs.rm(temporary, { force: true });
      }
    }
    const report = (downloadedBytes: number) => {
      options?.onTransfer?.({
        mode: "full",
        downloadSize: artifact.size,
        downloadedBytes,
        reusedBytes: 0,
        fallback,
      });
      onProgress?.(downloadedBytes / artifact.size);
    };
    report(0);
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
        report(size);
      }
      onVerifying?.();
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
