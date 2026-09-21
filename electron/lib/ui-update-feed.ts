import {
  compareVersions,
  sha256,
  validateManifest,
  type UiArtifact,
  type UiManifest,
} from "./ui-update-format.js";
import {
  getUpdateProxyUrl,
  updateRequestUrl,
  updateRedirectUrl,
} from "./update-network.js";

const REPO = "coldmint9/Synax";
const API = `https://api.github.com/repos/${REPO}/releases`;

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}
export interface Release {
  body?: string;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}
export interface UiRelease {
  manifest: UiManifest;
  assets: ReleaseAsset[];
}

export async function fetchGithubResponse(
  url: string,
  timeout = 30_000,
  options: {
    range?: { start: number; end: number };
    signal?: AbortSignal;
  } = {},
): Promise<Response> {
  const range = options.range;
  if (
    range &&
    (!Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 0 ||
      range.end <= range.start)
  )
    throw new Error("Invalid update byte range");
  const timeoutSignal = AbortSignal.timeout(timeout);
  const signal = options.signal
    ? AbortSignal.any([timeoutSignal, options.signal])
    : timeoutSignal;
  const proxy = getUpdateProxyUrl();
  let parsed = updateRequestUrl(url, proxy);
  for (let redirect = 0; redirect < 6; redirect++) {
    let response: Response;
    try {
      response = await fetch(parsed, {
        redirect: "manual",
        signal,
        credentials: "omit",
        headers: {
          "User-Agent": "Synax-updater",
          Accept: range
            ? "application/octet-stream"
            : "application/vnd.github+json",
          ...(range
            ? {
                Range: `bytes=${range.start}-${range.end - 1}`,
                "Accept-Encoding": "identity",
              }
            : {}),
        },
      });
    } catch (error) {
      const cause =
        error instanceof Error
          ? (error.cause as { code?: string } | undefined)
          : undefined;
      const reason =
        cause?.code ?? (error instanceof Error ? error.message : String(error));
      throw new Error(
        `GitHub ${proxy ? "proxy" : "direct"} update request failed (${parsed.host}): ${reason}`,
        { cause: error },
      );
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Missing GitHub redirect location");
      parsed = updateRedirectUrl(location, parsed, proxy);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(
        `GitHub update request failed (${response.status}) via ${proxy ? "proxy" : "direct"}: ${parsed.host}`,
      );
    }
    return response;
  }
  throw new Error("Too many GitHub redirects");
}

export async function fetchLimited(
  url: string,
  limit: number,
): Promise<Buffer> {
  const response = await fetchGithubResponse(url);
  const reader = response.body!.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit)
        throw new Error("GitHub update response exceeds size limit");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

export async function findUiRelease(
  appVersion: string,
  currentVersion: string | null,
  rejected: string[],
): Promise<UiRelease | null> {
  const releases: Release[] = [];
  for (let page = 1; page <= 5; page++) {
    const batch = JSON.parse(
      (
        await fetchLimited(`${API}?per_page=100&page=${page}`, 5_000_000)
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
      /^ui-v\d+\.\d+\.\d+$/.test(release.tag_name) &&
      !rejected.includes(release.tag_name.slice(4)) &&
      (!currentVersion ||
        compareVersions(release.tag_name.slice(4), currentVersion) > 0),
  );
  candidates.sort((a, b) =>
    compareVersions(b.tag_name.slice(4), a.tag_name.slice(4)),
  );
  for (const release of candidates) {
    const asset = release.assets.find(
      (item) => item.name === "ui-manifest.json",
    );
    if (!asset) continue;
    const manifest = validateManifest(
      JSON.parse(
        (await fetchLimited(asset.browser_download_url, 1_000_000)).toString(
          "utf8",
        ),
      ),
    );
    if (
      manifest.version === release.tag_name.slice(4) &&
      manifest.appVersion === appVersion &&
      release.assets.some((item) => item.name === manifest.full.name)
    ) {
      return { manifest, assets: release.assets };
    }
  }
  return null;
}

export async function fetchUiArtifact(
  release: UiRelease,
  artifact: UiArtifact,
): Promise<Buffer> {
  const asset = release.assets.find((item) => item.name === artifact.name);
  if (!asset) throw new Error(`Missing GitHub UI asset: ${artifact.name}`);
  const data = await fetchLimited(asset.browser_download_url, artifact.size);
  if (data.length !== artifact.size || sha256(data) !== artifact.sha256) {
    throw new Error("GitHub UI asset checksum mismatch");
  }
  return data;
}
