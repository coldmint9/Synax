import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import os from "node:os";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDesktopBlockMap } from "../../scripts/desktop-blockmap.js";
import { signDesktopManifest } from "./desktop-update-signing.js";
import {
  cacheDesktopRelease,
  desktopReleaseDirectory,
} from "./desktop-update-cache.js";
import {
  downloadDesktopRelease,
  type DesktopRelease,
} from "./desktop-update-feed.js";
import {
  coalesceDifferentialRanges,
  validateDesktopBlockMap,
} from "./desktop-differential.js";
import { OperationKind } from "./desktop-differential-engine.js";
import { hashFile } from "./desktop-update-format.js";
import { sha256 } from "./ui-update-format.js";
import {
  configureUpdateNetwork,
  DEFAULT_UPDATE_NETWORK,
} from "./update-network.js";

const trust = vi.hoisted(() => ({ publicKey: "" }));
vi.mock("./desktop-update-signing.js", async (original) => {
  const actual = await original<typeof import("./desktop-update-signing.js")>();
  return {
    ...actual,
    verifyDesktopManifestSignature: (
      manifest: Parameters<typeof actual.verifyDesktopManifestSignature>[0],
    ) => actual.verifyDesktopManifestSignature(manifest, trust.publicKey),
  };
});
const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString();
const publicKey = keys.publicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");
let root: string;
let old: DesktopRelease;
let next: DesktopRelease;
let oldBytes: Buffer;
let nextBytes: Buffer;
let destination: string;
let fetch: ReturnType<typeof vi.fn>;
let maps: Map<string, Buffer>;

async function fixture(version: string, bytes: Buffer) {
  const name = `Synax-${version}-darwin-arm64.zip`;
  const source = path.join(root, name);
  await fs.writeFile(source, bytes);
  const map = await createDesktopBlockMap(source, `${source}.blockmap`);
  const release: DesktopRelease = {
    manifest: signDesktopManifest(
      {
        format: 1,
        version,
        platform: "darwin",
        arch: "arm64",
        artifact: {
          name: `Synax-${version}-darwin-arm64.dmg`,
          size: 1,
          sha256: sha256(Buffer.from("d")),
        },
        updateArchive: { name, size: bytes.length, sha256: sha256(bytes) },
        blockMap: map,
      },
      privateKey,
      publicKey,
    ),
    url: `https://github.com/coldmint9/Synax/releases/download/v${version}/${name}`,
  };
  maps.set(`${name}.blockmap`, await fs.readFile(`${source}.blockmap`));
  return release;
}
function response(url: URL, options?: RequestInit): Response {
  const name = url.pathname.split("/").at(-1)!;
  if (maps.has(name)) return new Response(maps.get(name)!);
  const header = new Headers(options?.headers).get("Range");
  if (!header) return new Response(nextBytes);
  const range = /^bytes=(\d+)-(\d+)$/.exec(header)!;
  const start = Number(range[1]);
  const end = Number(range[2]);
  return new Response(nextBytes.subarray(start, end + 1), {
    status: 206,
    headers: {
      "content-range": `bytes ${start}-${end}/${nextBytes.length}`,
      "content-length": String(end - start + 1),
    },
  });
}
beforeEach(async () => {
  trust.publicKey = publicKey;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-differential-"));
  maps = new Map();
  oldBytes = randomBytes(1024 * 1024);
  nextBytes = Buffer.from(oldBytes);
  nextBytes.set(randomBytes(32 * 1024), 400 * 1024);
  old = await fixture("0.2.0", oldBytes);
  next = await fixture("0.2.1", nextBytes);
  const cache = path.join(root, "desktop-updates");
  await cacheDesktopRelease(cache, old);
  await fs.writeFile(
    path.join(
      desktopReleaseDirectory(cache, old.manifest),
      old.manifest.updateArchive!.name,
    ),
    oldBytes,
  );
  destination = desktopReleaseDirectory(cache, next.manifest);
  fetch = vi.fn(async (url: URL, options?: RequestInit) =>
    response(url, options),
  );
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  configureUpdateNetwork(DEFAULT_UPDATE_NETWORK);
  await fs.rm(root, { recursive: true, force: true });
});

it("reuses old ZIP bytes, downloads only changed ranges, verifies the reconstructed package and caches it", async () => {
  const transfer = vi.fn();
  const progress = vi.fn();
  const file = await downloadDesktopRelease(
    next,
    destination,
    progress,
    undefined,
    { currentVersion: "0.2.0", onTransfer: transfer },
  );
  // Compare every byte without the deep-equality overhead of a 1 MiB Buffer.
  expect((await fs.readFile(file)).equals(nextBytes)).toBe(true);
  const last = transfer.mock.lastCall![0];
  expect(last.mode).toBe("differential");
  expect(last.downloadSize).toBeLessThan(nextBytes.length / 2);
  expect(last.downloadedBytes).toBe(last.downloadSize);
  expect(last.reusedBytes + last.downloadSize).toBe(nextBytes.length);
  expect(progress).toHaveBeenLastCalledWith(1);
  expect(
    fetch.mock.calls
      .filter(([url]) => !String(url).endsWith(".blockmap"))
      .every(([, options]) => new Headers(options.headers).has("Range")),
  ).toBe(true);
  expect(
    (await fs.readdir(destination)).some((name) => name.endsWith(".part")),
  ).toBe(false);
  fetch.mockClear();
  await downloadDesktopRelease(next, destination, undefined, undefined, {
    currentVersion: "0.2.0",
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps proxy routing and Range headers for blockmaps and changed bytes", async () => {
  configureUpdateNetwork({
    mode: "custom",
    customProxyUrl: "https://proxy.example/prefix/",
  });
  const file = await downloadDesktopRelease(
    next,
    destination,
    undefined,
    undefined,
    { currentVersion: "0.2.0" },
  );
  expect((await fs.readFile(file)).equals(nextBytes)).toBe(true);
  expect(
    fetch.mock.calls.every(([url]) =>
      String(url).startsWith(
        "https://proxy.example/prefix/https://github.com/",
      ),
    ),
  ).toBe(true);
  const request = fetch.mock.calls.find(([, options]) =>
    new Headers(options.headers).has("Range"),
  )!;
  expect(new Headers(request[1].headers).get("Accept-Encoding")).toBe(
    "identity",
  );
});

it.each([
  "no-range",
  "wrong-range",
  "truncated",
  "corrupt",
  "encoded",
  "network",
])(
  "falls back to a verified full ZIP after %s differential failure",
  async (kind) => {
    fetch.mockImplementation(async (url: URL, options: RequestInit) => {
      if (!new Headers(options.headers).has("Range"))
        return response(url, options);
      if (kind === "network") throw new Error("range request failed");
      const correct = response(url, options);
      if (kind === "no-range") return new Response(nextBytes);
      const bytes = new Uint8Array(await correct.arrayBuffer());
      if (kind === "wrong-range")
        correct.headers.set(
          "content-range",
          `bytes 0-${bytes.length - 1}/${nextBytes.length}`,
        );
      if (kind === "encoded") correct.headers.set("content-encoding", "gzip");
      return new Response(
        kind === "truncated"
          ? bytes.subarray(1)
          : kind === "corrupt"
            ? Buffer.alloc(bytes.length)
            : bytes,
        { status: 206, headers: correct.headers },
      );
    });
    const transfer = vi.fn();
    const file = await downloadDesktopRelease(
      next,
      destination,
      undefined,
      undefined,
      { currentVersion: "0.2.0", onTransfer: transfer },
    );
    expect((await fs.readFile(file)).equals(nextBytes)).toBe(true);
    expect(transfer.mock.lastCall![0]).toMatchObject({
      mode: "full",
      fallback: true,
      downloadedBytes: nextBytes.length,
    });
    expect(
      (await fs.readdir(destination)).some((name) => name.endsWith(".part")),
    ).toBe(false);
  },
);

it.each(["missing-base", "damaged-base", "wrong-version", "no-key"])(
  "uses full download safely with %s",
  async (kind) => {
    const baseFile = path.join(
      root,
      "desktop-updates",
      "0.2.0-darwin-arm64",
      old.manifest.updateArchive!.name,
    );
    if (kind === "missing-base") await fs.rm(baseFile);
    if (kind === "damaged-base")
      await fs.writeFile(baseFile, Buffer.alloc(oldBytes.length));
    if (kind === "no-key") trust.publicKey = "";
    const transfer = vi.fn();
    const file = await downloadDesktopRelease(
      next,
      destination,
      undefined,
      undefined,
      {
        currentVersion: kind === "wrong-version" ? "0.1.9" : "0.2.0",
        onTransfer: transfer,
      },
    );
    expect((await fs.readFile(file)).equals(nextBytes)).toBe(true);
    expect(transfer.mock.lastCall![0].mode).toBe("full");
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it("rejects altered signed metadata before any download, rather than downgrading to unsigned full mode", async () => {
  next.manifest.updateArchive!.sha256 = "f".repeat(64);
  await expect(
    downloadDesktopRelease(next, destination, undefined, undefined, {
      currentVersion: "0.2.0",
    }),
  ).rejects.toThrow("signature");
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects tampered blockmaps and a damaged full fallback without publishing an installable file", async () => {
  maps.set(
    next.manifest.blockMap!.name,
    Buffer.alloc(next.manifest.blockMap!.size),
  );
  fetch.mockImplementation(async (url: URL, options: RequestInit) =>
    String(url).endsWith(".blockmap")
      ? response(url, options)
      : new Response(Buffer.alloc(nextBytes.length)),
  );
  await expect(
    downloadDesktopRelease(next, destination, undefined, undefined, {
      currentVersion: "0.2.0",
    }),
  ).rejects.toThrow("checksum");
  await expect(
    fs.access(path.join(destination, next.manifest.updateArchive!.name)),
  ).rejects.toThrow();
  expect(
    (await fs.readdir(destination)).some((name) => name.endsWith(".part")),
  ).toBe(false);
});

it("bounds and validates decompressed blockmaps", () => {
  const valid = JSON.parse(
    gunzipSync(maps.get(next.manifest.blockMap!.name)!).toString(),
  );
  expect(validateDesktopBlockMap(valid, nextBytes.length)).toEqual(valid);
  for (const bad of [
    null,
    { ...valid, version: "1" },
    { ...valid, files: [] },
    { ...valid, files: [{ ...valid.files[0], offset: -1 }] },
    {
      ...valid,
      files: [
        {
          ...valid.files[0],
          sizes: [nextBytes.length + 1],
          checksums: ["a".repeat(24)],
        },
      ],
    },
  ])
    expect(() => validateDesktopBlockMap(bad, nextBytes.length)).toThrow();
});

it("merges small intervening copy gaps without changing output order or mutating the upstream plan", () => {
  const operations = [
    { kind: OperationKind.DOWNLOAD, start: 0, end: 10 },
    { kind: OperationKind.COPY, start: 100, end: 110 },
    { kind: OperationKind.DOWNLOAD, start: 20, end: 30 },
    { kind: OperationKind.COPY, start: 1000, end: 1010 },
  ];
  expect(coalesceDifferentialRanges(operations)).toEqual([
    { kind: OperationKind.DOWNLOAD, start: 0, end: 30 },
    operations[3],
  ]);
  expect(operations[0].end).toBe(10);
});

it("uses full download when the calculated transfer would not save bandwidth", async () => {
  nextBytes = randomBytes(nextBytes.length);
  next = await fixture("0.2.1", nextBytes);
  const transfer = vi.fn();
  const file = await downloadDesktopRelease(
    next,
    destination,
    undefined,
    undefined,
    { currentVersion: "0.2.0", onTransfer: transfer },
  );
  expect((await fs.readFile(file)).equals(nextBytes)).toBe(true);
  expect(transfer.mock.lastCall![0].mode).toBe("full");
  expect(
    fetch.mock.calls.every(
      ([, options]) => !new Headers(options.headers).has("Range"),
    ),
  ).toBe(true);
});

it.skipIf(
  !process.env.SYNAX_DELTA_SMOKE_OLD_ZIP ||
    !process.env.SYNAX_DELTA_SMOKE_NEW_ZIP,
)(
  "reconstructs real ZIP releases byte-for-byte using only changed ranges",
  async () => {
    const oldZip = process.env.SYNAX_DELTA_SMOKE_OLD_ZIP!;
    const newZip = process.env.SYNAX_DELTA_SMOKE_NEW_ZIP!;
    async function realRelease(
      version: string,
      source: string,
    ): Promise<DesktopRelease> {
      const name = `Synax-${version}-darwin-arm64.zip`;
      const mapFile = path.join(root, `${name}.blockmap`);
      const blockMap = await createDesktopBlockMap(source, mapFile);
      maps.set(blockMap.name, await fs.readFile(mapFile));
      return {
        manifest: signDesktopManifest(
          {
            format: 1,
            version,
            platform: "darwin",
            arch: "arm64",
            artifact: {
              name: `Synax-${version}-darwin-arm64.dmg`,
              size: 1,
              sha256: sha256(Buffer.from("d")),
            },
            updateArchive: {
              name,
              size: (await fs.stat(source)).size,
              sha256: await hashFile(source),
            },
            blockMap,
          },
          privateKey,
          publicKey,
        ),
        url: `https://github.com/coldmint9/Synax/releases/download/v${version}/${name}`,
      };
    }
    old = await realRelease("0.2.0", oldZip);
    next = await realRelease("0.2.1", newZip);
    await cacheDesktopRelease(path.join(root, "desktop-updates"), old);
    await fs.copyFile(
      oldZip,
      path.join(
        root,
        "desktop-updates",
        "0.2.0-darwin-arm64",
        old.manifest.updateArchive!.name,
      ),
    );
    let bytes = 0;
    let requests = 0;
    fetch.mockImplementation(async (url: URL, options: RequestInit) => {
      const map = maps.get(url.pathname.split("/").at(-1)!);
      if (map) return new Response(map);
      const range = /^bytes=(\d+)-(\d+)$/.exec(
        new Headers(options.headers).get("Range") ?? "",
      );
      if (!range)
        throw new Error("Real ZIP smoke must not fall back to a full download");
      const start = Number(range[1]);
      const end = Number(range[2]);
      bytes += end - start + 1;
      requests++;
      return new Response(
        Readable.toWeb(
          createReadStream(newZip, { start, end }),
        ) as ReadableStream,
        {
          status: 206,
          headers: {
            "content-range": `bytes ${start}-${end}/${next.manifest.updateArchive!.size}`,
            "content-length": String(end - start + 1),
          },
        },
      );
    });
    const transfer = vi.fn();
    const file = await downloadDesktopRelease(
      next,
      destination,
      undefined,
      undefined,
      { currentVersion: "0.2.0", onTransfer: transfer },
    );
    expect(await hashFile(file)).toBe(next.manifest.updateArchive!.sha256);
    expect((await fs.stat(file)).size).toBe(next.manifest.updateArchive!.size);
    expect(transfer.mock.lastCall![0]).toMatchObject({
      mode: "differential",
      downloadedBytes: bytes,
    });
    console.info("Real ZIP differential reconstruction", {
      fullBytes: next.manifest.updateArchive!.size,
      downloadedBytes: bytes,
      rangeRequests: requests,
    });
  },
  120_000,
);
