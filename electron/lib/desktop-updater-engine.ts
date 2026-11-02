import { NsisUpdater, type AppUpdater, type UpdateInfo } from "electron-updater";
import { GenericProvider } from "electron-updater/out/providers/GenericProvider.js";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider.js";
import type { GenericServerOptions } from "builder-util-runtime";
import {
  frameworkChannel,
  frameworkUpdateInfo,
} from "../updater/framework-feed.js";
import { effectiveUpdateSource } from "../updater/effective-update-source.js";
import { updateRequestUrl } from "./update-network.js";
import { DmgMacUpdater, needsMacCompatibilityUpdater } from "./mac-compat-updater.js";

/** All macOS builds share the DMG installer; native Squirrel.Mac requires ZIP. */
export async function createFrameworkUpdater(
  platform: string,
  inspectMac = needsMacCompatibilityUpdater,
  resolveSource: () => string = effectiveUpdateSource,
): Promise<AppUpdater> {
  resolveSource();
  if (platform === "darwin") {
    // Unexpected signature inspection failures still fail closed. The bundle
    // installer preserves signed apps' designated requirements for both modes.
    await inspectMac(process.execPath);
    return new DmgMacUpdater(resolveSource);
  }
  if (platform === "win32") return new NsisUpdater();
  throw new Error("此平台请通过发布页手动安装更新。");
}

export function configureFrameworkFeed(
  updater: AppUpdater,
  platform: string,
  arch: string,
  proxy: string | null,
  resolveSource: () => string = effectiveUpdateSource,
): void {
  const feed = resolveSource();
  const channel = frameworkChannel(platform, arch);
  class UpdateProvider extends GenericProvider {
    constructor(_options: unknown, host: AppUpdater, runtime: ProviderRuntimeOptions) {
      const options: GenericServerOptions = {
        provider: "generic",
        url: updateRequestUrl(feed, proxy, feed).href,
        channel,
        useMultipleRangeRequest: false,
      };
      super(options, host, { ...runtime, isUseMultipleRangeRequest: false });
    }
    override async getLatestVersion(): Promise<UpdateInfo> {
      const info = await super.getLatestVersion();
      if (resolveSource() !== feed) throw new Error("Synax 自动更新不可用：企业更新源已变更，请重新检查。");
      return frameworkUpdateInfo(info, platform, arch, proxy, () => feed);
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
