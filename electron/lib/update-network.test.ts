import { afterEach, describe, expect, it } from "vitest";
import {
  configureUpdateNetwork,
  DEFAULT_UPDATE_NETWORK,
  getUpdateProxyUrl,
  GH_PROXY_URL,
  updateRedirectUrl,
  updateRequestUrl,
  validateUpdateNetworkSettings,
} from "./update-network.js";

afterEach(() => configureUpdateNetwork(DEFAULT_UPDATE_NETWORK));

describe("update network settings", () => {
  it("defaults to direct and supports preset and normalized custom prefixes", () => {
    expect(getUpdateProxyUrl()).toBeNull();
    configureUpdateNetwork({ mode: "gh-proxy", customProxyUrl: "" });
    expect(getUpdateProxyUrl()).toBe(GH_PROXY_URL);
    configureUpdateNetwork({
      mode: "custom",
      customProxyUrl: " https://proxy.example/prefix/// ",
    });
    expect(getUpdateProxyUrl()).toBe("https://proxy.example/prefix/");
    configureUpdateNetwork({
      mode: "direct",
      customProxyUrl: "https://proxy.example/",
    });
    expect(getUpdateProxyUrl()).toBeNull();
  });

  it.each([
    null,
    {},
    { mode: "unknown", customProxyUrl: "" },
    { mode: "custom", customProxyUrl: "" },
    ...[
      "http://proxy.example",
      "file:///tmp/proxy",
      "https://user:secret@proxy.example",
      "https://proxy.example/?token=secret",
      "https://proxy.example/#hash",
      "https://proxy.example/?",
      "https://proxy.example/\\path",
      "not a URL",
    ].map((customProxyUrl) => ({ mode: "custom", customProxyUrl })),
  ])("rejects invalid settings: %j", (value) => {
    expect(() => validateUpdateNetworkSettings(value)).toThrow();
  });

  it("preserves GitHub query strings and prefixes API and asset requests", () => {
    for (const url of [
      "https://api.github.com/repos/coldmint9/Synax/releases?per_page=100&page=2",
      "https://github.com/coldmint9/Synax/releases/download/v0.2.1/desktop-darwin-arm64.json",
      "https://release-assets.githubusercontent.com/asset?sig=a%2Fb&x=1",
    ]) {
      expect(updateRequestUrl(url, null).href).toBe(url);
      expect(updateRequestUrl(url, GH_PROXY_URL).href).toBe(GH_PROXY_URL + url);
    }
  });

  it("routes official and already-proxied redirects without double-prefixing", () => {
    const current = updateRequestUrl("https://github.com/asset", GH_PROXY_URL);
    const cdn = "https://release-assets.githubusercontent.com/asset?sig=abc";
    expect(updateRedirectUrl(cdn, current, GH_PROXY_URL).href).toBe(
      GH_PROXY_URL + cdn,
    );
    expect(
      updateRedirectUrl(GH_PROXY_URL + cdn, current, GH_PROXY_URL).href,
    ).toBe(GH_PROXY_URL + cdn);
    expect(
      updateRedirectUrl("/https://github.com/other", current, GH_PROXY_URL)
        .href,
    ).toBe(GH_PROXY_URL + "https://github.com/other");
    expect(
      updateRedirectUrl("/other", new URL("https://github.com/asset"), null)
        .href,
    ).toBe("https://github.com/other");
  });

  it.each([
    "http://github.com/asset",
    "https://github.com:8443/asset",
    "https://user:secret@github.com/asset",
    "https://evil.example/asset",
    "https://gh-proxy.org.evil.example/https://github.com/asset",
    "https://gh-proxy.org/https://evil.example/asset",
    "https://gh-proxy.org/login",
  ])("rejects unsafe sources and redirects: %s", (url) => {
    expect(() => updateRequestUrl(url, GH_PROXY_URL)).toThrow();
    expect(() =>
      updateRedirectUrl(
        url,
        new URL(GH_PROXY_URL + "https://github.com/asset"),
        GH_PROXY_URL,
      ),
    ).toThrow();
  });
});
