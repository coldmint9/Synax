import { afterEach, describe, expect, it, vi } from "vitest";
import { findUiRelease, fetchLimited, fetchUiArtifact } from "./ui-update-feed.js";
import { encodeUiArchive, sha256 } from "./ui-update-format.js";

const bytes = Buffer.from("interface");
const full = encodeUiArchive(new Map([["index.html", bytes]]));
const manifest = { format: 1, version: "1.2.0", appVersion: "0.1.2", files: [{ path: "index.html", sha256: sha256(bytes), size: bytes.length }], full: { name: "ui-full.json.gz", sha256: sha256(full), size: full.length } };
const asset = (name: string) => ({ name, browser_download_url: `https://github.com/coldmint9/Synax/releases/download/ui-v1.2.0/${name}` });
const releases = [{ tag_name: "ui-v1.2.0", draft: false, prerelease: false, assets: [asset("ui-manifest.json"), asset("ui-full.json.gz")] }, { tag_name: "ui-v9.0.0", draft: true, prerelease: false, assets: [] }];

afterEach(() => vi.unstubAllGlobals());
describe("GitHub update feed", () => {
  it("selects a compatible published UI release and validates downloaded assets", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: URL) => new Response(url.pathname.endsWith("ui-manifest.json") ? JSON.stringify(manifest) : url.pathname.endsWith("ui-full.json.gz") ? full : JSON.stringify(releases))));
    const result = await findUiRelease("0.1.2", "1.1.0", []);
    expect(result?.manifest.version).toBe("1.2.0");
    expect(await fetchUiArtifact(result!, result!.manifest.full)).toEqual(full);
    expect(await findUiRelease("0.1.3", null, [])).toBeNull();
    expect(await findUiRelease("0.1.2", "1.2.0", [])).toBeNull();
    expect(await findUiRelease("0.1.2", null, ["1.2.0"])).toBeNull();
  });
  it("rejects non-GitHub hosts, oversized responses and tampered assets", async () => {
    await expect(fetchLimited("http://github.com/bad", 100)).rejects.toThrow("GitHub");
    await expect(fetchLimited("https://evil.example/asset", 100)).rejects.toThrow("GitHub");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.alloc(200))));
    await expect(fetchLimited("https://github.com/bad", 100)).rejects.toThrow("size limit");
    await expect(fetchUiArtifact({ manifest: manifest as any, assets: [asset("ui-full.json.gz")] }, manifest.full)).rejects.toThrow("size limit");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.alloc(full.length))));
    await expect(fetchUiArtifact({ manifest: manifest as any, assets: [asset("ui-full.json.gz")] }, manifest.full)).rejects.toThrow("checksum");
  });
});
