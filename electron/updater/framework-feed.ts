import type { UpdateInfo } from "electron-updater";
import { updateRequestUrl } from "../lib/update-network.js";
import { compareVersions } from "../lib/ui-update-format.js";

export const FRAMEWORK_FEED_URL =
  "https://github.com/coldmint9/Synax/releases/latest/download/";
export const DESKTOP_RELEASE_URL =
  "https://github.com/coldmint9/Synax/releases/latest";

/** A missing channel is normal for releases published before the migration,
 * but only verified stable release metadata can establish that no upgrade exists. */
export function missingFrameworkChannel(release: unknown, current: string): UpdateInfo {
  const value = release as { tag_name?: unknown; draft?: unknown; prerelease?: unknown } | null;
  if (!value || value.draft !== false || value.prerelease !== false ||
    typeof value.tag_name !== "string" || !/^v\d+\.\d+\.\d+$/.test(value.tag_name) ||
    !/^\d+\.\d+\.\d+$/.test(current))
    throw new Error("无法确认最新正式版信息，请稍后重试。");
  const version = value.tag_name.slice(1);
  if (compareVersions(version, current) > 0)
    throw new Error(`正式版 ${version} 的更新清单尚未就绪或当前更新源无法访问，请稍后重试，或从 ${DESKTOP_RELEASE_URL} 手动下载。`);
  // No download is offered: never invent checksums or URLs for a legacy release.
  return { version: current, files: [], path: "", sha512: "", releaseDate: "" };
}

export function frameworkChannel(platform: string, arch: string): string {
  if (!["darwin", "win32"].includes(platform) || !["x64", "arm64"].includes(arch))
    throw new Error("自动更新仅支持 macOS 和 Windows 的 x64/arm64 安装版。");
  return `stable-${platform}-${arch}`;
}

/** Pin downloads to the version checked, even if latest changes afterwards. */
export function frameworkUpdateInfo(
  info: UpdateInfo,
  platform: string,
  arch: string,
  proxy: string | null,
): UpdateInfo {
  frameworkChannel(platform, arch);
  if (!/^\d+\.\d+\.\d+$/.test(info.version) || "packages" in info || info.files?.length !== 1)
    throw new Error("更新清单格式错误或包含不支持的安装包。");
  const file = info.files[0];
  const name = platform === "darwin"
    ? `Synax-${info.version}-darwin-${arch}.zip`
    : `Synax-${info.version}-win32-${arch}-NSIS.exe`;
  const source = `https://github.com/coldmint9/Synax/releases/download/v${info.version}/${name}`;
  if (
    file.url !== source ||
    !Number.isSafeInteger(file.size) || file.size! <= 0 ||
    !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512) ||
    file.blockMapSize !== undefined
  )
    throw new Error("更新安装包与版本、平台、架构或校验信息不匹配。");
  return {
    ...info,
    files: [{ ...file, url: updateRequestUrl(source, proxy).href }],
  };
}
