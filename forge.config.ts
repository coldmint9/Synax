import type { ForgeConfig } from "@electron-forge/shared-types";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDmgNative } from "./scripts/prepare-dmg-native.js";
import {
  desktopProduct,
  desktopIcon,
  desktopDownloadName,
  normalizeDesktopArtifacts,
  windowsMetadata,
} from "./scripts/desktop-branding.js";

const icon = desktopIcon(process.platform);
const windowsIcon = desktopIcon("win32");
const dmgInstallHelp = fileURLToPath(new URL("./scripts/dmg/", import.meta.url));

const config: ForgeConfig = {
  hooks: {
    preMake: async () => {
      ensureDmgNative();
    },
    prePackage: async (_config, platform, arch) => {
      if (platform !== process.platform || arch !== process.arch) {
        throw new Error(
          `Native dependencies must be built on ${platform}/${arch}; use the matching desktop CI runner, not ${process.platform}/${process.arch}.`,
        );
      }
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
    icon,
    asar: true,
    extraResource: [
      "./server-dist",
      "./web/dist",
      "./api/db/migrations",
      "./electron/resources/icon.png",
      "./electron/resources/icon.ico",
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
          "https://raw.githubusercontent.com/coldmint9/Synax/main/electron/resources/icon.ico",
        authors: desktopProduct.author,
        description: desktopProduct.description,
      }),
    },
  ],
};

export default config;
