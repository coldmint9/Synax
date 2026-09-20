import type { ForgeConfig } from "@electron-forge/shared-types";
import path from "node:path";
import { existsSync } from "node:fs";

const icon = path.resolve(
  __dirname,
  `electron/resources/icon.${process.platform === "darwin" ? "icns" : process.platform === "win32" ? "ico" : "png"}`,
);

const config: ForgeConfig = {
  hooks: {
    prePackage: async (_config, platform, arch) => {
      if (platform !== process.platform || arch !== process.arch) {
        throw new Error(
          `Native dependencies must be built on ${platform}/${arch}; use the matching desktop CI runner, not ${process.platform}/${process.arch}.`,
        );
      }
    },
  },
  rebuildConfig: {
    onlyModules: [],
  },
  packagerConfig: {
    name: "Synax",
    appBundleId: "com.Synax.desktop",
    ...(existsSync(icon) ? { icon } : {}),
    asar: true,
    extraResource: [
      "./server-dist",
      "./web/dist",
      "./api/db/migrations",
      "./electron/resources/icon.png",
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
      config: {
        format: "ULFO",
      },
    },
    {
      name: "@electron-forge/maker-zip",
      config: {},
      platforms: ["darwin", "linux", "win32"],
    },
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: "Synax",
        ...(existsSync(icon) && process.platform === "win32"
          ? { setupIcon: icon }
          : {}),
        authors: "Synax",
        description: "AI-powered code analysis platform",
      },
    },
  ],
};

export default config;
