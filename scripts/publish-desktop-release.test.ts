import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const publishRelease = createRequire(import.meta.url)(
  "./publish-desktop-release.cjs",
);
const mac = [
  "Synax-0.2.0-darwin-arm64.zip",
  "Synax-0.2.0-darwin-arm64.dmg",
  "desktop-darwin-arm64.json",
  "stable-darwin-arm64-mac.yml",
  "Synax-0.2.0-darwin-arm64.zip.blockmap",
];
const windows = [
  "Synax-0.2.0-win32-x64.zip",
  "Synax-0.2.0-win32-x64-Setup.exe",
  "Synax-0.2.0-full.nupkg",
  "RELEASES",
  "desktop-win32-x64.json",
  "stable-win32-x64.yml",
  "Synax-0.2.0-win32-x64-NSIS.exe",
  "Synax-0.2.0-full.nupkg.blockmap",
];
const digest = `sha256:${createHash("sha256").update("fixture").digest("hex")}`;
it.each(["missing-feed", "missing-nsis", "corrupt-nsis", "same-size-corrupt-nsis", "missing-legacy"])(
  "rejects %s before publishing either protocol",
  async (kind) => {
    await addFiles(windows);
    const file = path.join(root, "release-assets", kind === "missing-feed"
      ? windows[5] : kind === "missing-legacy" ? windows[2] : windows[6]);
    if (kind.startsWith("missing")) await fs.rm(file);
    else await fs.writeFile(file, kind === "same-size-corrupt-nsis" ? "corrupt" : "broken installer");
    await expect(publishRelease(input, root)).rejects.toThrow(/Missing desktop asset|does not match/);
    expect(input.github.rest.repos.createRelease).not.toHaveBeenCalled();
    expect(input.github.rest.repos.uploadReleaseAsset).not.toHaveBeenCalled();
  },
);
it.each(["version", "arch", "traversal", "host", "size", "sha512", "path", "duplicate-file"])(
  "rejects framework metadata with invalid %s",
  async (kind) => {
    const file = path.join(root, "release-assets", mac[3]);
    const feed = JSON.parse(await fs.readFile(file, "utf8"));
    if (kind === "version") feed.version = "0.3.0";
    if (kind === "arch") feed.files[0].url = feed.files[0].url.replace("arm64", "x64");
    if (kind === "traversal") feed.files[0].url = "../" + mac[0];
    if (kind === "host") feed.files[0].url = feed.files[0].url.replace("github.com", "example.com");
    if (kind === "size") feed.files[0].size += 1;
    if (kind === "sha512") feed.sha512 = feed.files[0].sha512 = createHash("sha512").update("other").digest("base64");
    if (kind === "path") feed.path = "../" + mac[0];
    if (kind === "duplicate-file") feed.files.push(feed.files[0]);
    await fs.writeFile(file, JSON.stringify(feed));
    await expect(publishRelease(input, root)).rejects.toThrow(/framework metadata|does not match/);
    expect(input.github.rest.repos.uploadReleaseAsset).not.toHaveBeenCalled();
  },
);
it("uploads every installer and blockmap before both kinds of metadata", async () => {
  await addFiles(windows);
  await publishRelease(input, root);
  const uploaded = input.github.rest.repos.uploadReleaseAsset.mock.calls.map(([call]) => call.name as string);
  const metadata = uploaded.filter((name) => /^(desktop-|stable-)/.test(name));
  const binaries = uploaded.filter((name) => !/^(desktop-|stable-)/.test(name));
  expect(metadata).toHaveLength(4);
  for (const name of metadata)
    expect(uploaded.indexOf(name)).toBeGreaterThan(Math.max(...binaries.map((binary) => uploaded.indexOf(binary))));
});
it("requires a separate complete feed for each macOS architecture", async () => {
  const intel = mac.map((name) => name.replaceAll("arm64", "x64"));
  await addFiles(intel);
  await publishRelease(input, root);
  expect(input.github.rest.repos.uploadReleaseAsset).toHaveBeenCalledTimes(mac.length + intel.length);
  input.github.rest.repos.uploadReleaseAsset.mockClear();
  await fs.rm(path.join(root, "release-assets", intel[3]));
  await expect(publishRelease(input, root)).rejects.toThrow("stable-darwin-x64-mac.yml");
  expect(input.github.rest.repos.uploadReleaseAsset).not.toHaveBeenCalled();
});
let root: string;
let input: ReturnType<typeof client>;
function client() {
  return {
    context: {
      repo: { owner: "example", repo: "Synax" },
      ref: "refs/tags/v0.2.0",
      sha: "a".repeat(40),
      serverUrl: "https://github.com",
    },
    core: { notice: vi.fn() },
    github: {
      paginate: vi.fn().mockResolvedValue([]),
      rest: {
        repos: {
          getReleaseByTag: vi
            .fn()
            .mockRejectedValue(
              Object.assign(new Error("Not found"), { status: 404 }),
            ),
          createRelease: vi
            .fn()
            .mockResolvedValue({ data: { id: 42, draft: true } }),
          updateRelease: vi.fn(),
          listReleaseAssets: vi.fn(),
          deleteReleaseAsset: vi.fn(),
          uploadReleaseAsset: vi.fn(),
        },
      },
    },
  };
}
async function addFiles(names: string[]) {
  for (const name of names) {
    let content = "fixture";
    if (name.startsWith("desktop-")) {
      const target = name.slice(8, -5);
      const artifact = target.startsWith("darwin")
        ? `Synax-0.2.0-${target}.zip` : "Synax-0.2.0-full.nupkg";
      content = JSON.stringify({ format: 1, blockMap: {
        name: `${artifact}.blockmap`, size: 7,
        sha256: createHash("sha256").update("fixture").digest("hex"),
      } });
    }
    if (name.startsWith("stable-")) {
      const target = name.slice(7, -4).replace(/-mac$/, "");
      const artifact = `Synax-0.2.0-${target}${target.startsWith("darwin") ? ".zip" : "-NSIS.exe"}`;
      const url = `https://github.com/coldmint9/Synax/releases/download/v0.2.0/${artifact}`;
      const sha512 = createHash("sha512").update("fixture").digest("base64");
      content = JSON.stringify({ version: "0.2.0", path: url, sha512,
        files: [{ url, sha512, size: 7 }], releaseDate: new Date(0).toISOString() });
    }
    await fs.writeFile(
      path.join(root, "release-assets", name),
      content,
    );
  }
}
function published(names: string[] = []) {
  input.github.rest.repos.getReleaseByTag.mockResolvedValue({
    data: { id: 42, draft: false },
  });
  input.github.paginate.mockResolvedValue(
    names.map((name, id) => ({ name, id, digest })),
  );
}
beforeEach(async () => {
  input = client();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-release-"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ version: "0.2.0" }),
  );
  await fs.mkdir(path.join(root, "release-assets"));
  await addFiles(mac);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
async function addBlockMap() {
  const name = "Synax-0.2.0-darwin-arm64.zip.blockmap";
  const bytes = Buffer.from("compressed blockmap");
  await fs.writeFile(path.join(root, "release-assets", name), bytes);
  await fs.writeFile(
    path.join(root, "release-assets", mac[2]),
    JSON.stringify({
      format: 1,
      blockMap: {
        name,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    }),
  );
  return name;
}
it("publishes the blockmap before exposing its referencing update manifest", async () => {
  const name = await addBlockMap();
  await publishRelease(input, root);
  const uploaded = input.github.rest.repos.uploadReleaseAsset.mock.calls.map(
    ([call]) => call.name,
  );
  expect(uploaded).toHaveLength(mac.length);
  expect(uploaded.indexOf(name)).toBeLessThan(uploaded.indexOf(mac[2]));
  expect(uploaded.indexOf(name)).toBeLessThan(uploaded.indexOf(mac[3]));
});
it.each(["missing", "corrupt"])(
  "refuses a %s blockmap before publishing metadata",
  async (kind) => {
    const name = await addBlockMap();
    const file = path.join(root, "release-assets", name);
    if (kind === "missing") await fs.rm(file);
    else await fs.writeFile(file, "wrong bytes");
    await expect(publishRelease(input, root)).rejects.toThrow(
      /blockmap|Missing desktop asset/,
    );
    expect(input.github.rest.repos.uploadReleaseAsset).not.toHaveBeenCalled();
  },
);

it("publishes a successful macOS target without requiring Windows or Linux", async () => {
  await publishRelease(input, root);
  const { repos } = input.github.rest;
  expect(repos.createRelease).toHaveBeenCalledWith(
    expect.objectContaining({ tag_name: "v0.2.0", draft: true }),
  );
  expect(repos.uploadReleaseAsset).toHaveBeenCalledTimes(mac.length);
  expect(
    repos.uploadReleaseAsset.mock.calls.map(([call]) => call.name),
  ).toEqual(expect.arrayContaining(mac));
  expect(repos.uploadReleaseAsset.mock.calls.at(-1)![0].name).toBe(mac[3]);
  expect(repos.updateRelease).toHaveBeenCalledWith(
    expect.objectContaining({ draft: false, make_latest: "false" }),
  );
  expect(repos.updateRelease.mock.invocationCallOrder[0]).toBeGreaterThan(
    repos.uploadReleaseAsset.mock.invocationCallOrder.at(-1)!,
  );
});

it("advances latest only when all framework platforms have been uploaded", async () => {
  await addFiles(windows);
  await addFiles(mac.map((name) => name.replaceAll("arm64", "x64")));
  await publishRelease(input, root);
  expect(input.github.rest.repos.updateRelease).toHaveBeenCalledWith(
    expect.objectContaining({ draft: false, make_latest: "true" }),
  );
});

it("promotes a partial release after the missing platform arrives", async () => {
  const intel = mac.map((name) => name.replaceAll("arm64", "x64"));
  published([...mac, ...intel]);
  await addFiles(windows);
  await publishRelease(input, root);
  expect(input.github.rest.repos.updateRelease).toHaveBeenCalledWith(
    expect.objectContaining({ draft: false, make_latest: "true" }),
  );
  expect(input.github.rest.repos.uploadReleaseAsset.mock.calls.map(([call]) => call.name))
    .toEqual(expect.arrayContaining(windows));
});

it("does not promote an older complete release on rerun", async () => {
  const intel = mac.map((name) => name.replaceAll("arm64", "x64"));
  await addFiles(windows);
  await addFiles(intel);
  published([...mac, ...intel, ...windows]);
  await publishRelease(input, root);
  expect(input.github.rest.repos.uploadReleaseAsset).not.toHaveBeenCalled();
  expect(input.github.rest.repos.updateRelease).not.toHaveBeenCalled();
});

it("fills an already public empty release without hiding it", async () => {
  published();
  await publishRelease(input, root);
  expect(input.github.rest.repos.createRelease).not.toHaveBeenCalled();
  expect(input.github.rest.repos.uploadReleaseAsset).toHaveBeenCalledTimes(mac.length);
  expect(input.github.rest.repos.updateRelease).not.toHaveBeenCalled();
});

it("adds Windows on rerun without overwriting the published macOS files", async () => {
  published(mac);
  await addFiles(windows);
  await fs.writeFile(
    path.join(root, "release-assets", mac[0]),
    "different rebuild bytes",
  );
  const feedFile = path.join(root, "release-assets", mac[3]);
  const feed = JSON.parse(await fs.readFile(feedFile, "utf8"));
  feed.sha512 = createHash("sha512").update("different rebuild bytes").digest("base64");
  feed.files[0].sha512 = feed.sha512;
  feed.files[0].size = Buffer.byteLength("different rebuild bytes");
  await fs.writeFile(feedFile, JSON.stringify(feed));
  await publishRelease(input, root);
  const { repos } = input.github.rest;
  expect(
    repos.uploadReleaseAsset.mock.calls.map(([call]) => call.name),
  ).toEqual(expect.arrayContaining(windows));
  expect(repos.uploadReleaseAsset).toHaveBeenCalledTimes(windows.length);
  expect(repos.uploadReleaseAsset.mock.calls.at(-1)![0].name).toBe(windows[5]);
  expect(repos.deleteReleaseAsset).not.toHaveBeenCalled();
  expect(repos.updateRelease).not.toHaveBeenCalled();
});

it("does nothing when all platform assets are already published", async () => {
  published(mac);
  await publishRelease(input, root);
  expect(input.github.rest.repos.uploadReleaseAsset).not.toHaveBeenCalled();
  expect(input.github.rest.repos.deleteReleaseAsset).not.toHaveBeenCalled();
});

it("resumes an interrupted public upload when existing binary digests match", async () => {
  published(mac.slice(0, 2));
  await publishRelease(input, root);
  expect(input.github.rest.repos.uploadReleaseAsset.mock.calls.map(([call]) => call.name))
    .toEqual([mac[4], mac[2], mac[3]]);
  expect(input.github.rest.repos.deleteReleaseAsset).not.toHaveBeenCalled();
});

it("rejects conflicting public files before exposing a mismatching update manifest", async () => {
  published([mac[1]]);
  await fs.writeFile(
    path.join(root, "release-assets", mac[1]),
    "changed installer",
  );
  await expect(publishRelease(input, root)).rejects.toThrow(
    "differs from this build",
  );
  expect(input.github.rest.repos.uploadReleaseAsset).not.toHaveBeenCalled();
  expect(input.github.rest.repos.deleteReleaseAsset).not.toHaveBeenCalled();
});

it("can replace unpublished draft assets before publishing", async () => {
  published([mac[0]]);
  input.github.rest.repos.getReleaseByTag.mockResolvedValue({
    data: { id: 42, draft: true },
  });
  await publishRelease(input, root);
  expect(
    input.github.rest.repos.deleteReleaseAsset,
  ).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ asset_id: 0 }));
  expect(input.github.rest.repos.uploadReleaseAsset).toHaveBeenCalledTimes(mac.length);
  expect(input.github.rest.repos.updateRelease).toHaveBeenCalledWith(
    expect.objectContaining({ draft: false }),
  );
});

it("does not expose update metadata when an installer upload fails", async () => {
  published();
  input.github.rest.repos.uploadReleaseAsset.mockRejectedValueOnce(
    new Error("Upload failed"),
  );
  await expect(publishRelease(input, root)).rejects.toThrow("Upload failed");
  expect(
    input.github.rest.repos.uploadReleaseAsset.mock.calls.map(
      ([call]) => call.name,
    ),
  ).not.toContain(mac[2]);
  expect(input.github.rest.repos.updateRelease).not.toHaveBeenCalled();
});

it("keeps a newly created release in draft if an upload fails", async () => {
  input.github.rest.repos.uploadReleaseAsset.mockRejectedValueOnce(
    new Error("Upload failed"),
  );
  await expect(publishRelease(input, root)).rejects.toThrow("Upload failed");
  expect(input.github.rest.repos.updateRelease).not.toHaveBeenCalled();
});

it("skips publication if all platforms failed", async () => {
  await fs.rm(path.join(root, "release-assets"), { recursive: true });
  await publishRelease(input, root);
  expect(input.github.rest.repos.getReleaseByTag).not.toHaveBeenCalled();
  expect(input.github.rest.repos.createRelease).not.toHaveBeenCalled();
});

it("rejects a partial platform before changing the release", async () => {
  await fs.rm(path.join(root, "release-assets", mac[1]));
  await expect(publishRelease(input, root)).rejects.toThrow(
    "Missing desktop asset",
  );
  expect(input.github.rest.repos.getReleaseByTag).not.toHaveBeenCalled();
});

it("requires the tag to match the package version", async () => {
  input.context.ref = "refs/tags/v0.1.0";
  await expect(publishRelease(input, root)).rejects.toThrow(
    "package version tag",
  );
  expect(input.github.rest.repos.getReleaseByTag).not.toHaveBeenCalled();
});

it("propagates permission errors without attempting to create a replacement release", async () => {
  input.github.rest.repos.getReleaseByTag.mockRejectedValue(
    Object.assign(new Error("Forbidden"), { status: 403 }),
  );
  await expect(publishRelease(input, root)).rejects.toThrow("Forbidden");
  expect(input.github.rest.repos.createRelease).not.toHaveBeenCalled();
});
