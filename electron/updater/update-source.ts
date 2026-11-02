export const PRODUCT_NAME = "Synax";
export const PRODUCT_BUNDLE_ID = "com.Synax.desktop";
export const PRODUCT_URL = "https://github.com/coldmint9/Synax";
export const UPDATE_UNAVAILABLE = "Synax 自动更新不可用：未配置更新源。请在「设置 → 在线更新」中填写更新源地址。";
export const LEGACY_UPDATE_UNAVAILABLE = "Synax 独立 desktop/UI 更新通道不可用；请使用企业桌面完整安装包。";

/** Explicit operator configuration only. Never infer a GitLab or upstream API. */
export function frameworkFeedUrl(env: Record<string, string | undefined>): string {
  const value = env.SYNAX_FRAMEWORK_UPDATE_URL?.trim();
  if (!value) throw new Error(UPDATE_UNAVAILABLE);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    (url.port && url.port !== "443") || /[\\\s]/.test(value) || /%2f|%5c/i.test(url.pathname))
    throw new Error("Synax 企业更新源必须是 HTTPS 目录，且不能指向 Synax 上游发布源。");
  return url.href.replace(/\/+$/, "") + "/";
}

export function assertProductIdentity(value: unknown): void {
  const metadata = value as { productName?: unknown; bundleId?: unknown } | null;
  if (metadata?.productName !== PRODUCT_NAME || metadata?.bundleId !== PRODUCT_BUNDLE_ID)
    throw new Error("更新包产品身份不匹配：仅允许 Synax / com.Synax.desktop。");
}

/** Pure selection/validation shared by packaging and the Node-only resolver. */
export function resolveUpdateSource(
  env: Record<string, string | undefined>, packagedConfig?: unknown,
): string {
  // An explicitly empty/invalid override is a failure, never permission to fall back.
  if (env.SYNAX_FRAMEWORK_UPDATE_URL !== undefined) return frameworkFeedUrl(env);
  if (packagedConfig === undefined) throw new Error(UPDATE_UNAVAILABLE);
  assertProductIdentity(packagedConfig);
  const config = packagedConfig as { disabled?: unknown; provider?: unknown; url?: unknown };
  if (config.disabled === true) throw new Error(UPDATE_UNAVAILABLE);
  if (config.disabled !== false || config.provider !== "generic" || typeof config.url !== "string")
    throw new Error("Synax 企业更新源打包配置无效。");
  return frameworkFeedUrl({ SYNAX_FRAMEWORK_UPDATE_URL: config.url });
}

const PACKAGED_IDENTITY = {
  productName: PRODUCT_NAME,
  bundleId: PRODUCT_BUNDLE_ID,
  updaterCacheDirName: "synax-framework-updater",
};

/** Identity-only configuration for installers that must stay offline. */
export const OFFLINE_PACKAGED_UPDATE_CONFIG = {
  ...PACKAGED_IDENTITY,
  disabled: true,
} as const;

export function packagedUpdateConfig(env: Record<string, string | undefined>, platform: string, arch: string) {
  // CI injects an unset repository variable as an empty string. Such builds
  // still produce offline installers; runtime empty overrides remain errors.
  // Enablement is a user preference, so the build only bakes a default feed.
  if (!env.SYNAX_FRAMEWORK_UPDATE_URL?.trim()) return { ...OFFLINE_PACKAGED_UPDATE_CONFIG };
  return {
    ...PACKAGED_IDENTITY, disabled: false, provider: "generic", url: frameworkFeedUrl(env),
    channel: `stable-${platform}-${arch}`,
  };
}

/** Kept explicit so dormant legacy entry points cannot consume upstream caches. */
export function requireLegacyUpdateSource(): void {
  throw new Error(LEGACY_UPDATE_UNAVAILABLE);
}
