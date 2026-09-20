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
];
const windows = [
  "Synax-0.2.0-win32-x64.zip",
  "Synax-0.2.0-win32-x64-Setup.exe",
  "Synax-0.2.0-full.nupkg",
  "RELEASES",
  "desktop-win32-x64.json",
];
const digest = `sha256:${createHash("sha256").update("fixture").digest("hex")}`;
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
  for (const name of names)
    await fs.writeFile(path.join(root, "release-assets", name), "fixture");
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

it("publishes a successful macOS target without requiring Windows or Linux", async () => {
  await publishRelease(input, root);
  const { repos } = input.github.rest;
  expect(repos.createRelease).toHaveBeenCalledWith(
    expect.objectContaining({ tag_name: "v0.2.0", draft: true }),
  );
  expect(repos.uploadReleaseAsset).toHaveBeenCalledTimes(3);
  expect(
    repos.uploadReleaseAsset.mock.calls.map(([call]) => call.name),
  ).toEqual(expect.arrayContaining(mac));
  expect(repos.uploadReleaseAsset.mock.calls.at(-1)![0].name).toBe(mac[2]);
  expect(repos.updateRelease).toHaveBeenCalledWith(
    expect.objectContaining({ draft: false, make_latest: "true" }),
  );
  expect(repos.updateRelease.mock.invocationCallOrder[0]).toBeGreaterThan(
    repos.uploadReleaseAsset.mock.invocationCallOrder.at(-1)!,
  );
});

it("fills an already public empty release without hiding it", async () => {
  published();
  await publishRelease(input, root);
  expect(input.github.rest.repos.createRelease).not.toHaveBeenCalled();
  expect(input.github.rest.repos.uploadReleaseAsset).toHaveBeenCalledTimes(3);
  expect(input.github.rest.repos.updateRelease).not.toHaveBeenCalled();
});

it("adds Windows on rerun without overwriting the published macOS files", async () => {
  published(mac);
  await addFiles(windows);
  await fs.writeFile(
    path.join(root, "release-assets", mac[0]),
    "different rebuild bytes",
  );
  await publishRelease(input, root);
  const { repos } = input.github.rest;
  expect(
    repos.uploadReleaseAsset.mock.calls.map(([call]) => call.name),
  ).toEqual(expect.arrayContaining(windows));
  expect(repos.uploadReleaseAsset).toHaveBeenCalledTimes(5);
  expect(repos.uploadReleaseAsset.mock.calls.at(-1)![0].name).toBe(windows[4]);
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
  expect(
    input.github.rest.repos.uploadReleaseAsset,
  ).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: mac[2] }));
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
  expect(input.github.rest.repos.uploadReleaseAsset).toHaveBeenCalledTimes(3);
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
