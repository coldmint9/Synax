import type { UpdateInfo } from "electron-updater";
import { updateRequestUrl } from "../lib/update-network.js";

export const FRAMEWORK_FEED_URL =
  "https://github.com/coldmint9/Synax/releases/latest/download/";
export const DESKTOP_RELEASE_URL =
  "https://github.com/coldmint9/Synax/releases/latest";

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
