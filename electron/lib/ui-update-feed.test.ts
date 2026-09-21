import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findUiRelease,
  fetchLimited,
  fetchUiArtifact,
  fetchGithubResponse,
} from "./ui-update-feed.js";
import {
  configureUpdateNetwork,
  DEFAULT_UPDATE_NETWORK,
  GH_PROXY_URL,
} from "./update-network.js";
import { encodeUiArchive, sha256 } from "./ui-update-format.js";

const bytes = Buffer.from("interface");
const full = encodeUiArchive(new Map([["index.html", bytes]]));
const manifest = {
  format: 1,
  version: "1.2.0",
  appVersion: "0.1.2",
  files: [{ path: "index.html", sha256: sha256(bytes), size: bytes.length }],
  full: { name: "ui-full.json.gz", sha256: sha256(full), size: full.length },
};
const asset = (name: string) => ({
  name,
  browser_download_url: `https://github.com/coldmint9/Synax/releases/download/ui-v1.2.0/${name}`,
});
const releases = [
  {
    tag_name: "ui-v1.2.0",
    draft: false,
    prerelease: false,
    assets: [asset("ui-manifest.json"), asset("ui-full.json.gz")],
  },
  { tag_name: "ui-v9.0.0", draft: true, prerelease: false, assets: [] },
];

afterEach(() => {
  vi.unstubAllGlobals();
  configureUpdateNetwork(DEFAULT_UPDATE_NETWORK);
});
describe("GitHub update feed", () => {
  it("proxies version discovery, manifests and verified UI downloads", async () => {
    configureUpdateNetwork({ mode: "gh-proxy", customProxyUrl: "" });
    const request = vi.fn(async (url: URL) => {
      expect(url.href.startsWith(GH_PROXY_URL + "https://")).toBe(true);
      return new Response(
        url.pathname.endsWith("ui-manifest.json")
          ? JSON.stringify(manifest)
          : url.pathname.endsWith("ui-full.json.gz")
            ? full
            : JSON.stringify(releases),
      );
    });
    vi.stubGlobal("fetch", request);
    const release = await findUiRelease("0.1.2", null, []);
    expect(await fetchUiArtifact(release!, release!.manifest.full)).toEqual(
      full,
    );
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0][0].href).toContain("https://api.github.com/");
  });

  it("keeps redirects proxied, omits credentials and uses one network snapshot", async () => {
    configureUpdateNetwork({ mode: "gh-proxy", customProxyUrl: "" });
    const request = vi
      .fn()
      .mockImplementationOnce(async () => {
        configureUpdateNetwork(DEFAULT_UPDATE_NETWORK);
        return new Response(null, {
          status: 302,
          headers: {
            location:
              "https://release-assets.githubusercontent.com/asset?sig=1",
          },
        });
      })
      .mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", request);
    const response = await fetchGithubResponse("https://github.com/asset");
    expect(await response.text()).toBe("ok");
    expect(request.mock.calls[1][0].href).toBe(
      GH_PROXY_URL + "https://release-assets.githubusercontent.com/asset?sig=1",
    );
    expect(request.mock.calls[1][1]).toMatchObject({
      credentials: "omit",
      redirect: "manual",
    });
    expect(request.mock.calls[1][1].signal).toBe(
      request.mock.calls[0][1].signal,
    );
  });

  it("rejects untrusted redirect destinations before requesting them", async () => {
    configureUpdateNetwork({ mode: "gh-proxy", customProxyUrl: "" });
    const request = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/asset" },
        }),
    );
    vi.stubGlobal("fetch", request);
    await expect(
      fetchGithubResponse("https://github.com/asset"),
    ).rejects.toThrow("GitHub");
    expect(request).toHaveBeenCalledOnce();
  });

  it("reports the failed route, host and underlying network error", async () => {
    configureUpdateNetwork({
      mode: "custom",
      customProxyUrl: "https://proxy.example/",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(
        new TypeError("fetch failed", {
          cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
        }),
      ),
    );
    await expect(
      fetchGithubResponse("https://github.com/asset"),
    ).rejects.toThrow(
      "GitHub proxy update request failed (proxy.example): UND_ERR_CONNECT_TIMEOUT",
    );
  });
  it("selects a compatible published UI release and validates downloaded assets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: URL) =>
          new Response(
            url.pathname.endsWith("ui-manifest.json")
              ? JSON.stringify(manifest)
              : url.pathname.endsWith("ui-full.json.gz")
                ? full
                : JSON.stringify(releases),
          ),
      ),
    );
    const result = await findUiRelease("0.1.2", "1.1.0", []);
    expect(result?.manifest.version).toBe("1.2.0");
    expect(await fetchUiArtifact(result!, result!.manifest.full)).toEqual(full);
    expect(await findUiRelease("0.1.3", null, [])).toBeNull();
    expect(await findUiRelease("0.1.2", "1.2.0", [])).toBeNull();
    expect(await findUiRelease("0.1.2", null, ["1.2.0"])).toBeNull();
  });
  it("rejects non-GitHub hosts, oversized responses and tampered assets", async () => {
    await expect(fetchLimited("http://github.com/bad", 100)).rejects.toThrow(
      "GitHub",
    );
    await expect(
      fetchLimited("https://evil.example/asset", 100),
    ).rejects.toThrow("GitHub");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(Buffer.alloc(200))),
    );
    await expect(fetchLimited("https://github.com/bad", 100)).rejects.toThrow(
      "size limit",
    );
    await expect(
      fetchUiArtifact(
        { manifest: manifest as any, assets: [asset("ui-full.json.gz")] },
        manifest.full,
      ),
    ).rejects.toThrow("size limit");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(Buffer.alloc(full.length))),
    );
    await expect(
      fetchUiArtifact(
        { manifest: manifest as any, assets: [asset("ui-full.json.gz")] },
        manifest.full,
      ),
    ).rejects.toThrow("checksum");
  });
});
