export interface UpdateNetworkSettings {
  mode: "direct" | "gh-proxy" | "custom";
  customProxyUrl: string;
}

export const DEFAULT_UPDATE_NETWORK: Readonly<UpdateNetworkSettings> = {
  mode: "direct",
  customProxyUrl: "",
};
export const GH_PROXY_URL = "https://gh-proxy.org/";

const githubHosts = new Set([
  "api.github.com",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

export function validateUpdateNetworkSettings(
  value: unknown,
): UpdateNetworkSettings {
  const settings = value as UpdateNetworkSettings | null;
  if (
    !settings ||
    !["direct", "gh-proxy", "custom"].includes(settings.mode) ||
    typeof settings.customProxyUrl !== "string" ||
    settings.customProxyUrl.length > 2048
  )
    throw new Error("Invalid update network settings");

  let customProxyUrl = settings.customProxyUrl.trim();
  if (customProxyUrl) {
    let url: URL;
    try {
      url = new URL(customProxyUrl);
    } catch {
      throw new Error("Proxy URL must be an HTTPS URL prefix");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /[?#\\\s]/.test(customProxyUrl)
    )
      throw new Error(
        "Proxy URL must use HTTPS without credentials, query or fragment",
      );
    customProxyUrl = url.href.replace(/\/+$/, "") + "/";
  }
  if (settings.mode === "custom" && !customProxyUrl)
    throw new Error("A custom proxy URL is required");
  return { mode: settings.mode, customProxyUrl };
}

let network: Readonly<UpdateNetworkSettings> = DEFAULT_UPDATE_NETWORK;

export function configureUpdateNetwork(value: UpdateNetworkSettings): void {
  network = Object.freeze(validateUpdateNetworkSettings(value));
}

export function getUpdateProxyUrl(): string | null {
  return network.mode === "gh-proxy"
    ? GH_PROXY_URL
    : network.mode === "custom"
      ? network.customProxyUrl
      : null;
}

function githubUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !githubHosts.has(url.hostname) ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw new Error("Update URL must be hosted by GitHub over HTTPS");
  return url;
}

export function updateRequestUrl(value: string, proxy: string | null): URL {
  const source = githubUrl(value);
  return new URL(proxy ? proxy + source.href : source.href);
}

export function updateRedirectUrl(
  location: string,
  current: URL,
  proxy: string | null,
): URL {
  const target = new URL(location, current);
  // A proxy may return its own prefixed URL; validate the embedded source too.
  if (proxy && target.href.startsWith(proxy)) {
    githubUrl(target.href.slice(proxy.length));
    return target;
  }
  return updateRequestUrl(target.href, proxy);
}
