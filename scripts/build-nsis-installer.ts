import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, Platform, Arch, type Configuration } from "electron-builder";

export function nsisConfiguration(version: string, arch: string): Configuration {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !["x64", "arm64"].includes(arch))
    throw new Error("Invalid NSIS target");
  return {
    appId: "com.Synax.desktop",
    productName: "Synax",
    directories: { output: "out/make/nsis" },
    artifactName: `Synax-${version}-win32-${arch}-NSIS.exe`,
    publish: null,
    win: {
      target: ["nsis"],
      icon: "electron/resources/synax-icon.ico",
      ...(process.env.SYNAX_WINDOWS_PUBLISHER
        ? { publisherName: process.env.SYNAX_WINDOWS_PUBLISHER }
        : {}),
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      deleteAppDataOnUninstall: false,
      differentialPackage: false,
      runAfterFinish: true,
      // Keep Electron's existing Synax userData/data root across the transition.
      shortcutName: "Synax",
    },
  };
}

export async function buildNsisInstaller(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Build NSIS on the Windows native runner.");
  if (process.env.SYNAX_REQUIRE_SIGNED_UPDATES === "1" &&
    (!process.env.SYNAX_WINDOWS_PUBLISHER || !process.env.CSC_LINK || !process.env.CSC_KEY_PASSWORD))
    throw new Error("Stable Windows updates require the configured publisher and code signing certificate.");
  const { version } = JSON.parse(await fs.readFile("package.json", "utf8"));
  const packaged = path.resolve(`out/Synax-win32-${process.arch}`);
  await fs.access(path.join(packaged, "Synax.exe"));
  await build({
    prepackaged: packaged,
    targets: Platform.WINDOWS.createTarget("nsis", process.arch === "arm64" ? Arch.arm64 : Arch.x64),
    config: nsisConfiguration(version, process.arch),
    publish: "never",
  });
  // The first framework release uses full installers. Do not publish builder's
  // generic latest.yml or blockmaps alongside our architecture-specific feeds.
  const output = path.resolve("out/make/nsis");
  const expected = `Synax-${version}-win32-${process.arch}-NSIS.exe`;
  for (const entry of await fs.readdir(output)) {
    if (entry !== expected) await fs.rm(path.join(output, entry), { recursive: true, force: true });
  }
  await fs.access(path.join(output, expected));
}

if (process.platform === "win32" && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildNsisInstaller();
