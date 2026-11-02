import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { UiUpdateStore } from "../lib/ui-update-store.js";
import { findCachedDesktopRelease } from "../lib/desktop-update-cache.js";
import { sha256 } from "../lib/ui-update-format.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it.each([undefined, "https://updates.example/synax/"])("does not activate old UI/desktop cache with framework source %s", async (source) => {
  vi.stubEnv("SYNAX_FRAMEWORK_UPDATE_URL", source);
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-legacy-cache-"));
  try {
    const directory = path.join(root, "ui");
    const snapshot = path.join(directory, "ui-1.0.0");
    await fs.mkdir(snapshot, { recursive: true });
    const bytes = Buffer.from("old Synax UI");
    await fs.writeFile(path.join(snapshot, "index.html"), bytes);
    const manifest = { format: 1, version: "1.0.0", appVersion: "0.1.2", files: [{ path: "index.html", size: bytes.length, sha256: sha256(bytes) }], full: { name: "ui-full.json.gz", size: 1, sha256: "a".repeat(64) } };
    await fs.writeFile(path.join(snapshot, "manifest.json"), JSON.stringify(manifest));
    await fs.writeFile(path.join(directory, "state.json"), JSON.stringify({ active: "1.0.0", pending: "1.0.0", previous: null, awaitingHealth: false, rejected: [] }));
    const store = new UiUpdateStore(directory, "/bundled-synax", "0.1.2");
    await store.initialize();
    expect(store.root).toBe("/bundled-synax");
    expect(store.pendingVersion).toBeNull();
    expect(store.currentVersion).toBeNull();
    await expect(store.prepare({ manifest: manifest as any, assets: [] })).rejects.toThrow("不可用");
    const desktop = path.join(root, "0.2.0-darwin-arm64");
    await fs.mkdir(desktop);
    const name = "Synax-0.2.0-darwin-arm64.dmg";
    await fs.writeFile(path.join(desktop, name), bytes);
    await fs.writeFile(path.join(desktop, "release.json"), JSON.stringify({
      manifest: { format: 1, version: "0.2.0", platform: "darwin", arch: "arm64", artifact: { name, size: bytes.length, sha256: sha256(bytes) } },
      url: "https://github.com/coldmint9/Synax/releases/download/v0.2.0/" + name,
    }));
    expect(await findCachedDesktopRelease(root, "0.1.2", "darwin", "arm64")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
