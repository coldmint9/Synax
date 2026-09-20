import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  verifyDesktopArtifact,
  type DesktopManifest,
} from "./desktop-update-feed.js";

const run = promisify(execFile);

// All paths are positional arguments, never interpolated into shell source.
// Keep the old bundle until the new app reports that its API and UI are ready.
export const MAC_INSTALL_SCRIPT = `#!/bin/sh
set -u
parent_pid="$1"
target="$2"
workspace="$3"
shift 3
count=0
while kill -0 "$parent_pid" 2>/dev/null; do
  count=$((count + 1))
  if [ "$count" -ge 120 ]; then
    echo 'App did not exit; installation cancelled.' > "$workspace/status"
    exit 1
  fi
  /bin/sleep 1
done
if ! /bin/mv "$target" "$workspace/previous.app"; then
  echo 'Could not move the installed app; it was left unchanged.' > "$workspace/status"
  /usr/bin/open -n "$target" --args "$@"
  exit 1
fi
restore() {
  if [ -e "$target" ]; then /bin/mv "$target" "$workspace/failed.app"; fi
  /bin/mv "$workspace/previous.app" "$target"
  echo 'Installation failed; restored the previous app.' > "$workspace/status"
  /usr/bin/open -n "$target" --args "$@"
  exit 1
}
trap 'restore "$@"' HUP INT TERM
if ! /bin/mv "$workspace/next.app" "$target"; then restore "$@"; fi
if ! /usr/bin/open -n "$target" --args "$@"; then restore "$@"; fi
echo 'Installed; awaiting application health check.' > "$workspace/status"
`;

export function macApplicationPath(executable: string): string {
  const target = path.resolve(executable, "../../..");
  if (
    !target.endsWith(".app") ||
    path.dirname(executable) !== path.join(target, "Contents", "MacOS")
  )
    throw new Error("Cannot locate the installed Synax.app");
  return target;
}

export async function checkMacInstallLocation(
  executable: string,
): Promise<string> {
  const target = macApplicationPath(executable);
  const real = await fs.realpath(target);
  if (
    real !== target ||
    real.startsWith("/Volumes/") ||
    real.includes("/AppTranslocation/")
  )
    throw new Error("请先将 Synax 拖入“应用程序”文件夹，再打开应用进行升级。");
  try {
    await fs.access(path.dirname(target), constants.W_OK);
  } catch {
    throw new Error(
      "应用所在目录不可写，请将 Synax 安装到当前用户可写的“应用程序”文件夹后重试。",
    );
  }
  return target;
}

async function plist(bundle: string, key: string): Promise<string> {
  return (
    await run("/usr/libexec/PlistBuddy", [
      "-c",
      `Print :${key}`,
      path.join(bundle, "Contents/Info.plist"),
    ])
  ).stdout.trim();
}

export async function verifyMacBundle(
  bundle: string,
  current: string,
  version: string,
  arch: string,
): Promise<void> {
  if (!(await fs.lstat(bundle)).isDirectory())
    throw new Error("Update is missing Synax.app");
  if (
    (await plist(bundle, "CFBundleIdentifier")) !== "com.Synax.desktop" ||
    (await plist(current, "CFBundleIdentifier")) !== "com.Synax.desktop" ||
    (await plist(bundle, "CFBundleShortVersionString")) !== version ||
    (await plist(bundle, "CFBundleExecutable")) !== "Synax"
  )
    throw new Error(
      "The downloaded app identity or version does not match the release",
    );
  await run("/usr/bin/lipo", [
    path.join(bundle, "Contents/MacOS/Synax"),
    "-verify_arch",
    arch === "x64" ? "x86_64" : "arm64",
  ]);
  // Developer-signed installations must keep the same signing identity. Existing
  // unsigned/ad-hoc builds use the SHA-256 verified artifact from our GitHub release.
  let signature = "";
  try {
    signature = (await run("/usr/bin/codesign", ["-dv", current])).stderr;
  } catch {
    /* Unsigned build. */
  }
  if (/^TeamIdentifier=(?!not set).+/m.test(signature)) {
    const requirement = (
      await run("/usr/bin/codesign", ["-d", "-r-", current])
    ).stdout.match(/^designated => (.+)$/m)?.[1];
    if (!requirement)
      throw new Error("Cannot determine the installed app signing identity");
    await run("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      "-R",
      requirement,
      bundle,
    ]);
  }
}

export interface MacInstallation {
  version: string;
  target: string;
  workspace: string;
}

export async function prepareMacInstallation(
  dmg: string,
  manifest: DesktopManifest,
  executable: string,
  directory: string,
): Promise<MacInstallation> {
  if (
    manifest.platform !== "darwin" ||
    !(await verifyDesktopArtifact(dmg, manifest.artifact))
  )
    throw new Error("Desktop update checksum mismatch");
  const target = await checkMacInstallLocation(executable);
  const workspace = await fs.mkdtemp(
    path.join(path.dirname(target), ".synax-update-"),
  );
  const mount = await fs.mkdtemp(path.join(directory, "mount-"));
  let mounted = false;
  try {
    await run(
      "/usr/bin/hdiutil",
      [
        "attach",
        "-readonly",
        "-nobrowse",
        "-noautoopen",
        "-mountpoint",
        mount,
        dmg,
      ],
      { timeout: 120_000 },
    );
    mounted = true;
    const source = path.join(mount, "Synax.app");
    await verifyMacBundle(source, target, manifest.version, manifest.arch);
    await run("/usr/bin/ditto", [source, path.join(workspace, "next.app")], {
      timeout: 10 * 60_000,
    });
    await verifyMacBundle(
      path.join(workspace, "next.app"),
      target,
      manifest.version,
      manifest.arch,
    );
    await fs.writeFile(path.join(workspace, "install.sh"), MAC_INSTALL_SCRIPT, {
      mode: 0o700,
    });
    return { version: manifest.version, target, workspace };
  } catch (error) {
    await fs.rm(workspace, { recursive: true, force: true });
    throw error;
  } finally {
    if (mounted)
      await run("/usr/bin/hdiutil", ["detach", mount]).catch((error) =>
        console.error("[desktop-update] detach failed", error),
      );
    // Do not recursively remove a mount point if detach failed.
    await fs.rmdir(mount).catch(() => {});
  }
}

export async function launchMacInstaller(
  installation: MacInstallation,
  directory: string,
  parentPid = process.pid,
  launchArgs: string[] = [],
): Promise<void> {
  await fs.writeFile(
    path.join(directory, "pending-install.json"),
    JSON.stringify(installation),
    { mode: 0o600 },
  );
  const log = await fs.open(
    path.join(installation.workspace, "install.log"),
    "a",
    0o600,
  );
  try {
    const child = spawn(
      "/bin/sh",
      [
        path.join(installation.workspace, "install.sh"),
        String(parentPid),
        installation.target,
        installation.workspace,
        ...launchArgs,
      ],
      {
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
        cwd: installation.workspace,
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    child.unref();
  } finally {
    await log.close();
  }
}

export async function finishMacInstallation(
  directory: string,
  executable: string,
  version: string,
): Promise<void> {
  const file = path.join(directory, "pending-install.json");
  let pending: MacInstallation;
  try {
    pending = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const target = macApplicationPath(executable);
  if (pending.version !== version || pending.target !== target) return;
  if (
    typeof pending.workspace !== "string" ||
    path.dirname(pending.workspace) !== path.dirname(target) ||
    !/^\.synax-update-[a-zA-Z0-9]+$/.test(path.basename(pending.workspace)) ||
    (await fs.realpath(pending.workspace)) !== pending.workspace
  )
    throw new Error("Invalid pending desktop installation path");
  await fs.rm(pending.workspace, { recursive: true, force: true });
  await fs.rm(file, { force: true });
}
