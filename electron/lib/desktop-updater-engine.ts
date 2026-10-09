import { MacUpdater, NsisUpdater, type AppUpdater, type UpdateInfo } from "electron-updater";
import { GenericProvider } from "electron-updater/out/providers/GenericProvider.js";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider.js";
import type { GenericServerOptions } from "builder-util-runtime";
import {
  FRAMEWORK_FEED_URL,
  frameworkChannel,
  frameworkUpdateInfo,
  missingFrameworkChannel,
} from "../updater/framework-feed.js";
import { updateRequestUrl } from "./update-network.js";

/** Extend only URL resolution. Transfers, cache, checksums, native signature
 * validation and process handoff remain owned by electron-updater. */
export function createFrameworkUpdater(platform: string): AppUpdater {
  if (platform === "darwin") return new MacUpdater();
  if (platform === "win32") return new NsisUpdater();
  throw new Error("此平台请通过发布页手动安装更新。");
}

export function configureFrameworkFeed(
  updater: AppUpdater,
  platform: string,
  arch: string,
  proxy: string | null,
): void {
  const channel = frameworkChannel(platform, arch);
  class UpdateProvider extends GenericProvider {
    private readonly currentVersion: string;
    constructor(_options: unknown, host: AppUpdater, runtime: ProviderRuntimeOptions) {
      const options: GenericServerOptions = {
        provider: "generic",
        url: updateRequestUrl(FRAMEWORK_FEED_URL, proxy).href,
        channel,
        useMultipleRangeRequest: false,
      };
      super(options, host, { ...runtime, isUseMultipleRangeRequest: false });
      this.currentVersion = host.currentVersion.version;
    }
    override async getLatestVersion(): Promise<UpdateInfo> {
      let info: UpdateInfo;
      try {
        info = await super.getLatestVersion();
      } catch (error) {
        if ((error as { code?: string })?.code !== "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND") throw error;
        const release = await this.httpRequest(updateRequestUrl(
          "https://api.github.com/repos/coldmint9/Synax/releases/latest", proxy,
        ), { Accept: "application/vnd.github+json", "User-Agent": "Synax-Updater" });
        if (!release) throw new Error("无法确认最新正式版信息，请稍后重试。");
        return missingFrameworkChannel(JSON.parse(release), this.currentVersion);
      }
      return frameworkUpdateInfo(info, platform, arch, proxy);
    }
  }
  updater.setFeedURL({ provider: "custom", updateProvider: UpdateProvider });
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;
  updater.disableDifferentialDownload = true;
  updater.logger = console;
}
