import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "./ui-update-format.js";
import {
  configureUpdateNetwork,
  DEFAULT_UPDATE_NETWORK,
} from "./update-network.js";
import {
  desktopArtifactName,
  downloadDesktopRelease,
  findDesktopRelease,
  validateDesktopManifest,
  type DesktopManifest,
} from "./desktop-update-feed.js";

const bytes = Buffer.from("full desktop bundle");
const manifest: DesktopManifest = {
  format: 1,
  version: "0.2.0",
  platform: "darwin",
  arch: "arm64",
  artifact: {
    name: desktopArtifactName("0.2.0", "darwin", "arm64"),
    size: bytes.length,
    sha256: sha256(bytes),
  },
};
const asset = (name: string) => ({
  name,
  browser_download_url: `https://github.com/coldmint9/Synax/releases/download/v0.2.0/${name}`,
});
let directory: string;
afterEach(async () => {
  vi.unstubAllGlobals();
  configureUpdateNetwork(DEFAULT_UPDATE_NETWORK);
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

describe("desktop update feed", () => {
  it("prefers the macOS update ZIP while retaining DMG metadata for older clients", async () => {
    const zipBytes = Buffer.from("zip update payload");
    const name = "Synax-0.2.0-darwin-arm64.zip";
    const upgraded = {
      ...manifest,
      updateArchive: { name, size: zipBytes.length, sha256: sha256(zipBytes) },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: URL) =>
          new Response(
            url.pathname.endsWith(".zip")
              ? zipBytes
              : JSON.stringify(
                  url.pathname.endsWith(".json")
                    ? upgraded
                    : [
                        {
                          tag_name: "v0.2.0",
                          assets: [
                            asset("desktop-darwin-arm64.json"),
                            asset(manifest.artifact.name),
                            asset(name),
                          ],
                        },
                      ],
                ),
          ),
      ),
    );
    const release = await findDesktopRelease("0.1.2", "darwin", "arm64");
    expect(release!.url).toBe(asset(name).browser_download_url);
    expect(release!.manifest.artifact.name).toMatch(/\.dmg$/);
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "synax-update-zip-"));
    expect(
      await fs.readFile(await downloadDesktopRelease(release!, directory)),
    ).toEqual(zipBytes);
  });
  it("reports partial byte progress, enters verification only at EOF, and atomically commits the complete package", async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "synax-desktop-stream-"),
    );
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                stream = controller;
              },
            }),
          ),
      ),
    );
    const progress = vi.fn();
    const verifying = vi.fn();
    const release = {
      manifest,
      url: asset(manifest.artifact.name).browser_download_url,
    };
    const download = downloadDesktopRelease(
      release,
      directory,
      progress,
      verifying,
    );
    await vi.waitFor(() => expect(stream).toBeDefined());
    const split = Math.floor(bytes.length / 2);
    stream.enqueue(bytes.subarray(0, split));
    await vi.waitFor(() =>
      expect(progress).toHaveBeenCalledWith(split / bytes.length),
    );
    expect(verifying).not.toHaveBeenCalled();
    await expect(
      fs.access(path.join(directory, manifest.artifact.name)),
    ).rejects.toThrow();
    stream.enqueue(bytes.subarray(split));
    stream.close();
    const file = await download;
    expect(progress).toHaveBeenLastCalledWith(1);
    expect(verifying).toHaveBeenCalledOnce();
    expect(await fs.readFile(file)).toEqual(bytes);
    expect(await fs.readdir(directory)).toEqual([manifest.artifact.name]);
  });

  it("removes an interrupted download instead of turning it into a cache", async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "synax-desktop-stream-"),
    );
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                stream = controller;
              },
            }),
          ),
      ),
    );
    const progress = vi.fn();
    const download = downloadDesktopRelease(
      { manifest, url: asset(manifest.artifact.name).browser_download_url },
      directory,
      progress,
    );
    const failed = expect(download).rejects.toThrow("connection lost");
    await vi.waitFor(() => expect(stream).toBeDefined());
    stream.enqueue(bytes.subarray(0, 2));
    await vi.waitFor(() => expect(progress).toHaveBeenCalled());
    stream.error(new Error("connection lost"));
    await failed;
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it("uses a custom proxy for discovery, the manifest and verified desktop package", async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "synax-desktop-feed-"));
    configureUpdateNetwork({
      mode: "custom",
      customProxyUrl: "https://proxy.example/prefix/",
    });
    const request = vi.fn(async (url: URL) => {
      expect(url.href.startsWith("https://proxy.example/prefix/https://")).toBe(
        true,
      );
      return new Response(
        url.pathname.endsWith(".dmg")
          ? bytes
          : JSON.stringify(
              url.pathname.endsWith(".json")
                ? manifest
                : [
                    {
                      tag_name: "v0.2.0",
                      assets: [
                        asset("desktop-darwin-arm64.json"),
                        asset(manifest.artifact.name),
                      ],
                    },
                  ],
            ),
      );
    });
    vi.stubGlobal("fetch", request);
    const release = await findDesktopRelease("0.1.2", "darwin", "arm64");
    expect(
      await fs.readFile(await downloadDesktopRelease(release!, directory)),
    ).toEqual(bytes);
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("chooses a newer full release for the exact platform, ignoring UI tags and prereleases", async () => {
    const releases = [
      { tag_name: "ui-v9.0.0", assets: [] },
      { tag_name: "v9.0.0", draft: true, assets: [] },
      { tag_name: "v8.0.0", prerelease: true, assets: [] },
      {
        tag_name: "v0.2.0",
        assets: [
          asset("desktop-darwin-arm64.json"),
          asset(manifest.artifact.name),
        ],
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: URL) =>
          new Response(
            JSON.stringify(
              url.pathname.endsWith(".json") ? manifest : releases,
            ),
          ),
      ),
    );
    expect(
      (await findDesktopRelease("0.1.2", "darwin", "arm64"))?.manifest,
    ).toEqual(manifest);
    expect(await findDesktopRelease("0.2.0", "darwin", "arm64")).toBeNull();
    expect(await findDesktopRelease("0.1.2", "darwin", "x64")).toBeNull();
    expect(await findDesktopRelease("0.1.2", "win32", "x64")).toBeNull();
  });

  it("rejects mismatched metadata and missing artifacts", async () => {
    const release = {
      tag_name: "v0.2.0",
      assets: [asset("desktop-darwin-arm64.json")],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: URL) =>
          new Response(
            JSON.stringify(
              url.pathname.endsWith(".json") ? manifest : [release],
            ),
          ),
      ),
    );
    expect(await findDesktopRelease("0.1.2", "darwin", "arm64")).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: URL) =>
          new Response(
            JSON.stringify(
              url.pathname.endsWith(".json")
                ? {
                    ...manifest,
                    version: "0.3.0",
                    artifact: {
                      ...manifest.artifact,
                      name: desktopArtifactName("0.3.0", "darwin", "arm64"),
                    },
                  }
                : [release],
            ),
          ),
      ),
    );
    await expect(
      findDesktopRelease("0.1.2", "darwin", "arm64"),
    ).rejects.toThrow("match");
  });

  it.each([
    { ...manifest, artifact: { ...manifest.artifact, name: "../Synax.app" } },
    { ...manifest, artifact: { ...manifest.artifact, size: 3 * 1024 ** 3 } },
    { ...manifest, artifact: { ...manifest.artifact, sha256: "bad" } },
    { ...manifest, arch: "other" },
  ])("rejects invalid manifest %#", (value) =>
    expect(() => validateDesktopManifest(value)).toThrow("manifest"),
  );

  it("streams and verifies a package, reuses a verified cache, and redownloads a corrupt cache", async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "synax-desktop-feed-"));
    const fetch = vi.fn(async () => new Response(bytes));
    vi.stubGlobal("fetch", fetch);
    const release = {
      manifest,
      url: asset(manifest.artifact.name).browser_download_url,
    };
    const file = await downloadDesktopRelease(release, directory);
    expect(await fs.readFile(file)).toEqual(bytes);
    await downloadDesktopRelease(release, directory);
    expect(fetch).toHaveBeenCalledOnce();
    await fs.writeFile(file, Buffer.alloc(bytes.length));
    await downloadDesktopRelease(release, directory);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    Buffer.alloc(bytes.length),
    Buffer.alloc(bytes.length + 1),
    Buffer.alloc(1),
  ])("never commits a corrupt or truncated download %#", async (data) => {
    configureUpdateNetwork({ mode: "gh-proxy", customProxyUrl: "" });
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "synax-desktop-feed-"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(data)),
    );
    await expect(
      downloadDesktopRelease(
        { manifest, url: asset(manifest.artifact.name).browser_download_url },
        directory,
      ),
    ).rejects.toThrow(/checksum|size limit/);
    expect(await fs.readdir(directory)).toEqual([]);
  });
});
