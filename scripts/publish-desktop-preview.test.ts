import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const publishPreview = createRequire(import.meta.url)(
  "./publish-desktop-preview.cjs",
);
const missing = () => Object.assign(new Error("Not found"), { status: 404 });
const context = {
  repo: { owner: "example", repo: "Synax" },
  ref: "refs/heads/main",
  sha: "a".repeat(40),
  serverUrl: "https://github.com",
  runId: 123,
  runNumber: 7,
};
let root: string;
let input: ReturnType<typeof client>;
function client() {
  return {
    context,
    core: { notice: vi.fn() },
    github: {
      paginate: vi
        .fn()
        .mockResolvedValue([{ id: 91, name: "old-version.zip" }]),
      rest: {
        git: {
          getRef: vi.fn(async ({ ref }) => {
            if (ref === "heads/main")
              return { data: { object: { sha: context.sha } } };
            throw missing();
          }),
          createRef: vi.fn(),
          updateRef: vi.fn(),
        },
        repos: {
          getReleaseByTag: vi.fn().mockRejectedValue(missing()),
          createRelease: vi.fn().mockResolvedValue({ data: { id: 42 } }),
          updateRelease: vi.fn(),
          listReleaseAssets: vi.fn(),
          deleteReleaseAsset: vi.fn(),
          uploadReleaseAsset: vi.fn(),
        },
      },
    },
  };
}
beforeEach(async () => {
  input = client();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-preview-"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ version: "0.2.0" }),
  );
  const dir = path.join(root, "release-assets", "make");
  await fs.mkdir(dir, { recursive: true });
  for (const target of [
    "darwin-x64",
    "darwin-arm64",
    "win32-x64",
    "linux-x64",
  ]) {
    const names = [`Synax-0.2.0-${target}.zip`];
    if (target.startsWith("darwin")) names.push(`Synax-0.2.0-${target}.dmg`);
    if (target.startsWith("win32"))
      names.push(
        `Synax-0.2.0-${target}-Setup.exe`,
        "Synax-0.2.0-full.nupkg",
        "RELEASES",
      );
    if (!target.startsWith("linux")) names.push(`desktop-${target}.json`);
    for (const name of names)
      await fs.writeFile(
        path.join(dir, name),
        name.startsWith("desktop-") ? JSON.stringify({ format: 1 }) : "fixture",
      );
  }
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

it("publishes all platforms before exposing a prerelease, without replacing latest stable", async () => {
  await publishPreview(input, root);
  const { repos, git } = input.github.rest;
  expect(repos.createRelease).toHaveBeenCalledWith(
    expect.objectContaining({
      tag_name: "preview",
      draft: true,
      prerelease: true,
      make_latest: "false",
      target_commitish: context.sha,
    }),
  );
  expect(repos.uploadReleaseAsset).toHaveBeenCalledTimes(12);
  expect(git.createRef).toHaveBeenCalledWith(
    expect.objectContaining({ ref: "refs/tags/preview", sha: context.sha }),
  );
  expect(repos.updateRelease).toHaveBeenCalledWith(
    expect.objectContaining({
      draft: false,
      prerelease: true,
      make_latest: "false",
    }),
  );
  expect(repos.updateRelease.mock.invocationCallOrder[0]).toBeGreaterThan(
    repos.uploadReleaseAsset.mock.invocationCallOrder.at(-1)!,
  );
  expect(repos.createRelease.mock.calls[0][0].body).toContain(context.sha);
});

it("replaces obsolete assets and moves the existing preview tag to the built commit", async () => {
  input.github.rest.repos.getReleaseByTag.mockResolvedValue({
    data: { id: 42, prerelease: true },
  });
  input.github.rest.git.getRef.mockResolvedValue({
    data: { object: { sha: context.sha } },
  });
  await publishPreview(input, root);
  const { repos, git } = input.github.rest;
  expect(repos.createRelease).not.toHaveBeenCalled();
  expect(repos.updateRelease.mock.calls[0][0].draft).toBe(true);
  expect(repos.deleteReleaseAsset).toHaveBeenCalledWith(
    expect.objectContaining({ asset_id: 91 }),
  );
  expect(git.updateRef).toHaveBeenCalledWith(
    expect.objectContaining({
      ref: "tags/preview",
      sha: context.sha,
      force: true,
    }),
  );
  expect(git.createRef).not.toHaveBeenCalled();
});

it("skips superseded main builds before modifying a release", async () => {
  input.github.rest.git.getRef.mockResolvedValue({
    data: { object: { sha: "b".repeat(40) } },
  });
  await publishPreview(input, root);
  expect(input.github.rest.repos.getReleaseByTag).not.toHaveBeenCalled();
  expect(input.github.rest.repos.createRelease).not.toHaveBeenCalled();
});

it("rejects incomplete platform assets before modifying a release", async () => {
  await fs.rm(
    path.join(root, "release-assets/make/Synax-0.2.0-darwin-x64.dmg"),
  );
  await expect(publishPreview(input, root)).rejects.toThrow(
    "Missing desktop asset",
  );
  expect(input.github.rest.repos.createRelease).not.toHaveBeenCalled();
});

it("does not expose partially uploaded assets on failure", async () => {
  input.github.rest.repos.uploadReleaseAsset.mockRejectedValueOnce(
    new Error("Upload failed"),
  );
  await expect(publishPreview(input, root)).rejects.toThrow("Upload failed");
  expect(input.github.rest.repos.updateRelease).not.toHaveBeenCalled();
  expect(input.github.rest.git.createRef).not.toHaveBeenCalled();
});

it("refuses to overwrite a stable release using the preview tag", async () => {
  input.github.rest.repos.getReleaseByTag.mockResolvedValue({
    data: { id: 42, prerelease: false },
  });
  await expect(publishPreview(input, root)).rejects.toThrow(
    "non-preview release",
  );
  expect(input.github.rest.repos.updateRelease).not.toHaveBeenCalled();
});

it("propagates access failures instead of treating them as a missing release", async () => {
  input.github.rest.repos.getReleaseByTag.mockRejectedValue(
    Object.assign(new Error("Forbidden"), { status: 403 }),
  );
  await expect(publishPreview(input, root)).rejects.toThrow("Forbidden");
  expect(input.github.rest.repos.createRelease).not.toHaveBeenCalled();
});

it("publishes successful platforms when Windows failed, without retaining stale Windows assets", async () => {
  for (const name of [
    "Synax-0.2.0-win32-x64.zip",
    "Synax-0.2.0-win32-x64-Setup.exe",
    "Synax-0.2.0-full.nupkg",
    "RELEASES",
    "desktop-win32-x64.json",
  ])
    await fs.rm(path.join(root, "release-assets/make", name));
  input.github.rest.repos.getReleaseByTag.mockResolvedValue({
    data: { id: 42, prerelease: true },
  });
  input.github.paginate.mockResolvedValue([
    { id: 91, name: "desktop-win32-x64.json" },
  ]);
  await publishPreview(input, root);
  const { repos } = input.github.rest;
  expect(repos.uploadReleaseAsset).toHaveBeenCalledTimes(7);
  expect(repos.deleteReleaseAsset).toHaveBeenCalledWith(
    expect.objectContaining({ asset_id: 91 }),
  );
  expect(repos.updateRelease).toHaveBeenLastCalledWith(
    expect.objectContaining({ draft: false }),
  );
  expect(repos.updateRelease.mock.calls.at(-1)![0].body).toContain(
    "Available platforms: darwin-x64, darwin-arm64, linux-x64",
  );
});

it("keeps the existing preview when every build failed", async () => {
  await fs.rm(path.join(root, "release-assets"), { recursive: true });
  await publishPreview(input, root);
  expect(input.github.rest.repos.getReleaseByTag).not.toHaveBeenCalled();
  expect(input.github.rest.repos.createRelease).not.toHaveBeenCalled();
  expect(input.core.notice).toHaveBeenCalledWith(
    expect.stringContaining("No successful desktop artifacts"),
  );
});

it("rejects duplicate artifact filenames before modifying a release", async () => {
  await fs.writeFile(
    path.join(root, "release-assets/Synax-0.2.0-linux-x64.zip"),
    "duplicate",
  );
  await expect(publishPreview(input, root)).rejects.toThrow(
    "Duplicate desktop asset",
  );
  expect(input.github.rest.repos.createRelease).not.toHaveBeenCalled();
});
