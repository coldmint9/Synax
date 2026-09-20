import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  hashFile,
  desktopArtifactName,
  type DesktopManifest,
} from "../electron/lib/desktop-update-feed.js";
import {
  prepareMacInstallation,
  launchMacInstaller,
  finishMacInstallation,
} from "../electron/lib/mac-desktop-update.js";

if (process.platform !== "darwin") process.exit(0);
const run = promisify(execFile);
const root = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "Synax Desktop Update Smoke ")),
);
const target = path.join(root, "Installed Apps", "Synax.app");
const source = path.join(root, "image", "Synax.app");
const cache = path.join(root, "profile", "desktop-updates");
const version = "0.2.0";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const executable = path.join(target, "Contents/MacOS/Synax");
const userData = path.join(root, "data", "keep.txt");

async function bundle(directory: string, version: string): Promise<void> {
  await fs.mkdir(path.join(directory, "Contents/MacOS"), { recursive: true });
  await fs.writeFile(
    path.join(directory, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.Synax.desktop</string>
<key>CFBundleName</key><string>Synax Update Smoke</string>
<key>CFBundleExecutable</key><string>Synax</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSUIElement</key><true/>
</dict></plist>`,
  );
  await fs.copyFile(
    path.join(root, "smoke-binary"),
    path.join(directory, "Contents/MacOS/Synax"),
  );
}

try {
  await fs.mkdir(cache, { recursive: true });
  await fs.mkdir(path.dirname(userData), { recursive: true });
  await fs.writeFile(userData, "existing project and settings");
  // A tiny independent Mach-O fixture exercises Launch Services without touching
  // a real Synax profile, opening user projects, or requiring a running API.
  await fs.writeFile(
    path.join(root, "smoke.c"),
    `#include <stdio.h>
#include <mach-o/dyld.h>
int main(void) {
  char executable[4096], marker[8192]; unsigned int size = sizeof(executable);
  if (_NSGetExecutablePath(executable, &size) != 0) return 1;
  snprintf(marker, sizeof(marker), "%s.launched", executable);
  FILE *file = fopen(marker, "w"); if (!file) return 2;
  fputs("launched", file); fclose(file); return 0;
}
`,
  );
  await run("/usr/bin/xcrun", [
    "clang",
    path.join(root, "smoke.c"),
    "-o",
    path.join(root, "smoke-binary"),
  ]);
  await bundle(target, "0.1.0");
  await bundle(source, version);
  const dmg = path.join(cache, desktopArtifactName(version, "darwin", arch));
  await run(
    "/usr/bin/hdiutil",
    [
      "create",
      "-srcfolder",
      path.dirname(source),
      "-volname",
      "Synax Update Smoke",
      "-format",
      "UDZO",
      dmg,
    ],
    { timeout: 120_000 },
  );
  const manifest: DesktopManifest = {
    format: 1,
    version,
    platform: "darwin",
    arch,
    artifact: {
      name: path.basename(dmg),
      size: (await fs.stat(dmg)).size,
      sha256: await hashFile(dmg),
    },
  };
  const installation = await prepareMacInstallation(
    dmg,
    manifest,
    executable,
    cache,
  );
  assert(
    (
      await fs.readFile(path.join(target, "Contents/Info.plist"), "utf8")
    ).includes("0.1.0"),
  );
  // The helper waits for a parent process that has already exited in this smoke.
  await launchMacInstaller(installation, cache, 99_999_999);
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await fs.access(`${executable}.launched`);
      break;
    } catch {
      if (Date.now() > deadline)
        throw new Error("Updated app was not relaunched");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(
    (
      await fs.readFile(path.join(target, "Contents/Info.plist"), "utf8")
    ).includes(version),
  );
  await fs.access(path.join(installation.workspace, "previous.app"));
  await finishMacInstallation(cache, executable, version);
  assert.equal(
    await fs.readFile(userData, "utf8"),
    "existing project and settings",
  );
  console.log(
    `Desktop update smoke passed: ${arch}; DMG verification, staging, replacement, relaunch, health cleanup and data preservation.`,
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
