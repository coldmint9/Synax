import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ForgeMakeResult } from "@electron-forge/shared-types";

const root = fileURLToPath(new URL("../", import.meta.url));
export const desktopProduct = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
) as {
  productName: string;
  version: string;
  description: string;
  author: string;
};
export const updaterDescription =
  "Software updater for the Synax AI coding workspace";

export function desktopIcon(platform: string): string {
  const extension =
    platform === "darwin" ? "icns" : platform === "win32" ? "ico" : "png";
  const icon = path.join(root, "electron/resources", `icon.${extension}`);
  if (!existsSync(icon))
    throw new Error(`Missing Synax application icon: ${icon}`);
  return icon;
}

export function windowsMetadata(
  name = desktopProduct.productName,
  description = desktopProduct.description,
) {
  return {
    CompanyName: desktopProduct.author,
    ProductName: name,
    FileDescription: description,
    InternalName: name,
    OriginalFilename: `${name}.exe`,
  };
}

export function desktopDownloadName(
  version: string,
  platform: string,
  arch: string,
  extension: "dmg" | "zip" | "exe",
): string {
  const base = `${desktopProduct.productName}-${version}-${platform}-${arch}`;
  return extension === "exe" ? `${base}-Setup.exe` : `${base}.${extension}`;
}

// Forge's ZIP maker has a fixed default name. Normalize its returned artifact
// paths too, so CI/publishers and local builds use the same public filenames.
export async function normalizeDesktopArtifacts(
  results: ForgeMakeResult[],
): Promise<ForgeMakeResult[]> {
  for (const result of results) {
    for (let i = 0; i < result.artifacts.length; i++) {
      const artifact = result.artifacts[i];
      const extension = path.extname(artifact).slice(1);
      if (extension !== "zip" && extension !== "dmg" && extension !== "exe")
        continue;
      const destination = path.join(
        path.dirname(artifact),
        desktopDownloadName(
          result.packageJSON.version,
          result.platform,
          result.arch,
          extension,
        ),
      );
      if (destination !== artifact) {
        await fs.rm(destination, { force: true });
        await fs.rename(artifact, destination);
        result.artifacts[i] = destination;
      }
    }
  }
  return results;
}
