import { afterEach, expect, it, vi } from "vitest";
import { findUiRelease, fetchLimited, fetchUiArtifact, fetchGithubResponse } from "./ui-update-feed.js";
import { configureUpdateNetwork, DEFAULT_UPDATE_NETWORK } from "./update-network.js";
import type { UiRelease } from "./ui-update-feed.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); configureUpdateNetwork(DEFAULT_UPDATE_NETWORK); });
it.each([undefined, "https://updates.example/synax/"])("does not mistake framework source %s for a UI release protocol", async (source) => {
  vi.stubEnv("SYNAX_FRAMEWORK_UPDATE_URL", source);
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  configureUpdateNetwork({ mode: "gh-proxy", customProxyUrl: "" });
  await expect(findUiRelease("0.1.2", null, [])).rejects.toThrow("不可用");
  await expect(fetchLimited("https://github.com/coldmint9/Synax/releases", 100)).rejects.toThrow("不可用");
  await expect(fetchGithubResponse("https://github.com/asset")).rejects.toThrow("不可用");
  const artifact = { name: "ui-full.json.gz", size: 1, sha256: "a".repeat(64) };
  await expect(fetchUiArtifact({ assets: [{ name: artifact.name, browser_download_url: "https://github.com/asset" }] } as UiRelease, artifact)).rejects.toThrow("不可用");
  expect(fetch).not.toHaveBeenCalled();
});
