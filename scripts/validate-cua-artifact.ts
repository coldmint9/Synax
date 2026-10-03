import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CUA_SDK_VERSION = "0.30.2";

type PackageManifest = {
  name?: string;
  version?: string;
  main?: string;
  module?: string;
};

function readManifest(path: string, label: string): PackageManifest {
  if (!existsSync(path)) throw new Error(`Missing CUA artifact ${label}: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
  } catch (error) {
    throw new Error(`Invalid CUA artifact manifest ${label}: ${path} (${String(error)})`);
  }
}

function requireFile(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`Missing CUA artifact ${label}: ${path}`);
}

function nativePackageName(platform: NodeJS.Platform, arch: string): string {
  if (platform === "darwin") return `@ubjs/node-darwin-${arch}`;
  if (platform === "linux") return `@ubjs/node-linux-${arch}-gnu`;
  if (platform === "win32") return `@ubjs/node-win32-${arch}-msvc`;
  throw new Error(`Unsupported CUA platform: ${platform}`);
}

export function validateCuaArtifact(options: {
  helperRoot: string;
  driverPath?: string;
  platform: NodeJS.Platform;
  arch: string;
  requireDriver?: boolean;
}): void {
  const { helperRoot, driverPath, platform, arch, requireDriver = true } = options;
  requireFile(join(helperRoot, "cua-helper.cjs"), "helper bundle");

  const driverPackage = readManifest(
    join(helperRoot, "node_modules/@trycua/cua-driver/package.json"),
    "@trycua/cua-driver package",
  );
  if (driverPackage.version !== CUA_SDK_VERSION)
    throw new Error(`CUA driver package version ${driverPackage.version ?? "unknown"} does not match ${CUA_SDK_VERSION}`);

  const core = readManifest(join(helperRoot, "node_modules/@ubjs/core/package.json"), "@ubjs/core package");
  if (core.version !== "0.31.0-3") throw new Error(`@ubjs/core version ${core.version ?? "unknown"} is not 0.31.0-3`);
  const node = readManifest(join(helperRoot, "node_modules/@ubjs/node/package.json"), "@ubjs/node package");
  if (node.version !== "0.31.0-3") throw new Error(`@ubjs/node version ${node.version ?? "unknown"} is not 0.31.0-3`);

  const nativeName = nativePackageName(platform, arch);
  const nativeRoot = join(helperRoot, "node_modules", ...nativeName.split("/"));
  const native = readManifest(join(nativeRoot, "package.json"), `${nativeName} package`);
  requireFile(join(nativeRoot, native.main ?? ""), `${nativeName} native module`);

  if (requireDriver) {
    if (!driverPath) throw new Error("Cua Driver path is required during desktop packaging");
    requireFile(driverPath, "driver binary");
  }
}
