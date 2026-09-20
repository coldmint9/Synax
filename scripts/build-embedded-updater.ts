import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "tsup";
import packager from "@electron/packager";
import {
  desktopProduct,
  desktopIcon,
  updaterDescription,
  windowsMetadata,
  updaterMacInfo,
} from "./desktop-branding.js";

const require = createRequire(import.meta.url);
export async function buildEmbeddedUpdater(
  platform = process.platform,
  arch = process.arch,
): Promise<void> {
  if (platform !== "darwin" && platform !== "win32") return;
  const payload = path.resolve("out/updater-payload");
  const output = path.resolve("out/updater-package");
  const embedded = path.resolve("out/updater");
  const { version } = desktopProduct;
  await fs.rm(payload, { recursive: true, force: true });
  await fs.mkdir(payload, { recursive: true });
  await build({
    config: false,
    entry: {
      main: "electron/updater/main.ts",
      preload: "electron/updater/preload.ts",
    },
    outDir: payload,
    format: ["cjs"],
    platform: "node",
    target: "node22",
    external: ["electron"],
    bundle: true,
    splitting: false,
    sourcemap: false,
    outExtension: () => ({ js: ".cjs" }),
    silent: true,
  });
  await build({
    config: false,
    entry: { renderer: "electron/updater/renderer.ts" },
    outDir: payload,
    format: ["iife"],
    platform: "browser",
    target: "es2022",
    bundle: true,
    splitting: false,
    outExtension: () => ({ js: ".js" }),
    silent: true,
  });
  await fs.copyFile(
    "electron/updater/index.html",
    path.join(payload, "index.html"),
  );
  await fs.writeFile(
    path.join(payload, "package.json"),
    JSON.stringify({
      name: "synax-updater",
      productName: "Synax Updater",
      description: updaterDescription,
      version,
      main: "main.cjs",
      author: "Synax",
      license: "MIT",
    }),
  );
  const paths = await packager({
    dir: payload,
    out: output,
    name: "Synax Updater",
    executableName: "Synax Updater",
    appBundleId: "com.Synax.updater",
    appVersion: version,
    appCopyright: "Copyright (c) 2026 Synax contributors",
    extendInfo: updaterMacInfo(platform),
    appCategoryType: "public.app-category.developer-tools",
    win32metadata: windowsMetadata("Synax Updater", updaterDescription),
    platform,
    arch,
    electronVersion: require("electron/package.json").version,
    asar: true,
    overwrite: true,
    prune: false,
    icon: desktopIcon(platform),
    extraResource: [desktopIcon("win32"), desktopIcon("linux")],
  });
  await fs.rm(embedded, { recursive: true, force: true });
  await fs.mkdir(embedded, { recursive: true });
  if (platform === "darwin")
    await fs.cp(
      path.join(paths[0], "Synax Updater.app"),
      path.join(embedded, "Synax Updater.app"),
      { recursive: true, verbatimSymlinks: true },
    );
  else
    await fs.cp(paths[0], embedded, {
      recursive: true,
      verbatimSymlinks: true,
    });
}
