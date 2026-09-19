import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUiReleaseArtifacts } from "../../scripts/ui-release-artifacts.js";
import { UiUpdateStore } from "./ui-update-store.js";
import { fetchUiArtifact } from "./ui-update-feed.js";
import type { UiRelease } from "./ui-update-feed.js";

vi.mock("./ui-update-feed.js", () => ({ fetchUiArtifact: vi.fn() }));
const mockFetch = vi.mocked(fetchUiArtifact);
let temp: string, builtIn: string, dist: string, data: string;
let archives: Map<string, Buffer>;
const store = () => new UiUpdateStore(data, builtIn, "0.1.2");
async function release(version: string, previous?: UiRelease): Promise<UiRelease> {
  const assets = await createUiReleaseArtifacts(dist, version, "0.1.2", previous?.manifest);
  archives.set(assets.manifest.full.sha256, assets.full);
  if (assets.delta) archives.set(assets.manifest.delta!.sha256, assets.delta);
  return { manifest: assets.manifest, assets: [assets.manifest.full, ...(assets.manifest.delta ? [assets.manifest.delta] : [])].map(({ name }) => ({ name, browser_download_url: "https://github.com/test" })) };
}

beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "synax-ui-store-"));
  builtIn = path.join(temp, "built-in"); dist = path.join(temp, "dist"); data = path.join(temp, "user-data");
  await fs.mkdir(builtIn); await fs.mkdir(dist);
  await fs.writeFile(path.join(builtIn, "index.html"), "bundled");
  archives = new Map();
  mockFetch.mockImplementation(async (_, artifact) => archives.get(artifact.sha256)!);
});
afterEach(async () => { vi.clearAllMocks(); await fs.rm(temp, { recursive: true, force: true }); });

describe("UI snapshot store", () => {
  it("stages a first full update, applies on restart, then uses an adjacent delta", async () => {
    await fs.writeFile(path.join(dist, "index.html"), "first");
    await fs.writeFile(path.join(dist, "unchanged.txt"), "retain");
    await fs.writeFile(path.join(dist, "obsolete.txt"), "to remove");
    const first = await release("1.0.0");
    const start = store(); await start.initialize();
    expect(start.root).toBe(builtIn);
    expect(await start.prepare(first)).toBe("full");
    expect(start.root).toBe(builtIn); // no reload until explicit restart
    const restarted = store(); await restarted.initialize();
    expect(await fs.readFile(path.join(restarted.root, "index.html"), "utf8")).toBe("first");
    await restarted.markHealthy();
    await fs.writeFile(path.join(dist, "index.html"), "second");
    await fs.rm(path.join(dist, "obsolete.txt"));
    const second = await release("1.0.1", first);
    expect(await restarted.prepare(second)).toBe("delta");
    const upgraded = store(); await upgraded.initialize();
    expect(await fs.readFile(path.join(upgraded.root, "index.html"), "utf8")).toBe("second");
    expect(await fs.readFile(path.join(upgraded.root, "unchanged.txt"), "utf8")).toBe("retain");
    await expect(fs.access(path.join(upgraded.root, "obsolete.txt"))).rejects.toThrow();
    // A failed startup reverts to the last healthy snapshot, and won't re-offer the bad version.
    const rollback = store(); await rollback.initialize();
    expect(rollback.currentVersion).toBe("1.0.0");
    expect(rollback.rejected).toContain("1.0.1");
  });

  it("uses a full UI archive when delta is missing or invalid", async () => {
    await fs.writeFile(path.join(dist, "index.html"), "one");
    const first = await release("1.0.0");
    const current = store(); await current.initialize(); await current.prepare(first);
    const restarted = store(); await restarted.initialize(); await restarted.markHealthy();
    await fs.writeFile(path.join(dist, "index.html"), "two");
    const next = await release("1.0.1", first);
    mockFetch.mockRejectedValueOnce(new Error("delta CDN offline"));
    expect(await restarted.prepare(next)).toBe("full");
    const later = await release("1.0.2", next);
    expect(await restarted.prepare(later)).toBe("full"); // current remains 1.0.0
  });

  it("falls back to full UI when the cached delta base is corrupted", async () => {
    await fs.writeFile(path.join(dist, "index.html"), "one");
    await fs.writeFile(path.join(dist, "retain.txt"), "valid");
    const first = await release("1.0.0");
    const current = store(); await current.initialize(); await current.prepare(first);
    const restarted = store(); await restarted.initialize(); await restarted.markHealthy();
    await fs.writeFile(path.join(dist, "index.html"), "two");
    const second = await release("1.0.1", first);
    await fs.writeFile(path.join(restarted.root, "retain.txt"), "damaged");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await restarted.prepare(second)).toBe("full");
    warn.mockRestore();
    const upgraded = store(); await upgraded.initialize();
    expect(await fs.readFile(path.join(upgraded.root, "retain.txt"), "utf8")).toBe("valid");
    expect(await upgraded.rollback()).toBe(true);
    expect(upgraded.root).toBe(builtIn); // the previous snapshot is damaged
  });

  it("does not activate an interrupted or corrupt download", async () => {
    await fs.writeFile(path.join(dist, "index.html"), "new");
    const target = await release("1.0.0");
    const current = store(); await current.initialize();
    mockFetch.mockRejectedValueOnce(new Error("interrupted"));
    await expect(current.prepare(target)).rejects.toThrow("interrupted");
    expect(current.pendingVersion).toBeNull();
    archives.set(target.manifest.full.sha256, Buffer.from("bad archive"));
    await expect(current.prepare(target)).rejects.toThrow();
    expect(current.root).toBe(builtIn);
  });

  it("recovers to bundled UI when the cached snapshot has been damaged", async () => {
    await fs.writeFile(path.join(dist, "index.html"), "new");
    const target = await release("1.0.0");
    const current = store(); await current.initialize(); await current.prepare(target);
    const upgraded = store(); await upgraded.initialize(); await upgraded.markHealthy();
    await fs.writeFile(path.join(upgraded.root, "index.html"), "tampered");
    const recovered = store(); await recovered.initialize();
    expect(recovered.root).toBe(builtIn);
    expect(recovered.rejected).toContain("1.0.0");
  });
});
