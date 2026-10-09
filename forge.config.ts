import type { ForgeConfig } from "@electron-forge/shared-types";
import path from "node:path";
import fs from "node:fs/promises";
import { stageCuaDriver } from "./scripts/stage-cua-driver.js";
import { fileURLToPath } from "node:url";
import { ensureDmgNative } from "./scripts/prepare-dmg-native.js";
import { validateCuaArtifact } from "./scripts/validate-cua-artifact.js";
import {
  desktopProduct,
  desktopIcon,
  desktopDownloadName,
  normalizeDesktopArtifacts,
  windowsMetadata,
} from "./scripts/desktop-branding.js";

const icon = desktopIcon(process.platform);
const windowsIcon = desktopIcon("win32");
const dmgInstallHelp = fileURLToPath(new URL("./scripts/dmg", import.meta.url));
const updateConfig = path.resolve("dist-electron/app-update.yml");

const config: ForgeConfig = {
  hooks: {
    preMake: async () => {
      ensureDmgNative();
    },
    prePackage: async (_config, platform, arch) => {
      // macOS code signing is optional, including tag builds. When configured,
      // packagerConfig.osxSign below still requires a valid installed identity.
      await fs.mkdir(path.dirname(updateConfig), { recursive: true });
      await fs.writeFile(updateConfig, JSON.stringify({
        provider: "generic",
        url: "https://github.com/coldmint9/Synax/releases/latest/download/",
        channel: `stable-${platform}-${arch}`,
        updaterCacheDirName: "synax-framework-updater",
        ...(process.env.SYNAX_WINDOWS_PUBLISHER
          ? { publisherName: [process.env.SYNAX_WINDOWS_PUBLISHER] }
          : {}),
      }));
      await stageCuaDriver(platform, arch);
      if (platform !== process.platform || arch !== process.arch) {
        throw new Error(
          `Native dependencies must be built on ${platform}/${arch}; use the matching desktop CI runner, not ${process.platform}/${process.arch}.`,
        );
      }
      validateCuaArtifact({
        helperRoot: path.resolve("cua-helper-dist"),
        driverPath: path.resolve("dist/cua-driver/cua-driver"),
        platform,
        arch,
      });
    },
    postMake: async (_config, results) => normalizeDesktopArtifacts(results),
  },
  rebuildConfig: {
    onlyModules: [],
  },
  packagerConfig: {
    name: desktopProduct.productName,
    executableName: desktopProduct.productName,
    appVersion: desktopProduct.version,
    appCopyright: "Copyright (c) 2026 Synax contributors",
    appCategoryType: "public.app-category.developer-tools",
    win32metadata: windowsMetadata(),
    appBundleId: "com.Synax.desktop",
    ...(process.env.SYNAX_MAC_SIGN_IDENTITY ? {
      osxSign: { identity: process.env.SYNAX_MAC_SIGN_IDENTITY },
    } : {}),
    ...(process.env.SYNAX_APPLE_ID && process.env.SYNAX_APPLE_APP_PASSWORD && process.env.SYNAX_APPLE_TEAM_ID ? {
      osxNotarize: {
        appleId: process.env.SYNAX_APPLE_ID,
        appleIdPassword: process.env.SYNAX_APPLE_APP_PASSWORD,
        teamId: process.env.SYNAX_APPLE_TEAM_ID,
      },
    } : {}),
    icon,
    asar: { unpack: "**/*.{node,dylib,dll,so}" },
    extraResource: [
      updateConfig,
      "./server-dist",
      "./dist/cua-driver",
      "./cua-helper-dist",
      "./client/dist",
      "./services/local-node/infrastructure/database/migrations",
      "./electron/resources/synax-icon.png",
      "./electron/resources/synax-icon.ico",
    ],
    ignore: (file: string) => {
      if (!file) return false;
      if (file === "/package.json") return false;
      if (file.startsWith("/dist-electron")) return false;
      return true;
    },
  },
  makers: [
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: (arch: string) => ({
        format: "ULFO",
        contents: (options) => [
          { x: 192, y: 344, type: "file", path: options.appPath },
          { x: 448, y: 344, type: "link", path: "/Applications" },
          {
            x: 192,
            y: 128,
            type: "file",
            path: path.join(dmgInstallHelp, "安装说明.txt"),
          },
          {
            x: 448,
            y: 128,
            type: "file",
            path: path.join(dmgInstallHelp, "安装后运行.command"),
          },
        ],
        name: path.basename(
          desktopDownloadName(desktopProduct.version, "darwin", arch, "dmg"),
          ".dmg",
        ),
      }),
    },
    {
      name: "@electron-forge/maker-zip",
      config: {},
      platforms: ["darwin", "linux", "win32"],
    },
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: (arch: string) => ({
        name: "Synax",
        title: desktopProduct.productName,
        exe: `${desktopProduct.productName}.exe`,
        setupExe: desktopDownloadName(
          desktopProduct.version,
          "win32",
          arch,
          "exe",
        ),
        setupIcon: windowsIcon,
        iconUrl:
          "https://raw.githubusercontent.com/coldmint9/Synax/main/electron/resources/synax-icon.ico",
        authors: desktopProduct.author,
        description: desktopProduct.description,
      }),
    },
  ],
};

export default config;
