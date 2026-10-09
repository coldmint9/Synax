import { MacUpdater, NsisUpdater, type AppUpdater, type UpdateInfo } from "electron-updater";
import { GenericProvider } from "electron-updater/out/providers/GenericProvider.js";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider.js";
import type { GenericServerOptions } from "builder-util-runtime";
import {
  FRAMEWORK_FEED_URL,
  frameworkChannel,
  frameworkUpdateInfo,
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
    constructor(_options: unknown, host: AppUpdater, runtime: ProviderRuntimeOptions) {
      const options: GenericServerOptions = {
        provider: "generic",
        url: updateRequestUrl(FRAMEWORK_FEED_URL, proxy).href,
        channel,
        useMultipleRangeRequest: false,
      };
      super(options, host, { ...runtime, isUseMultipleRangeRequest: false });
    }
    override async getLatestVersion(): Promise<UpdateInfo> {
      return frameworkUpdateInfo(await super.getLatestVersion(), platform, arch, proxy);
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
