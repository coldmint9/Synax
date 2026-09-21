import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface DesktopPathOptions {
  platform?: NodeJS.Platform;
  home?: string;
  shell?: string;
}

/** GUI launches omit shell-managed toolchains. Recover PATH once at startup,
 * without overriding a toolchain already selected by the launching terminal. */
export async function resolveDesktopPath(
  currentPath = "",
  options: DesktopPathOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return currentPath;
  const home = options.home ?? os.homedir();
  const shell = options.shell ?? (process.env.SHELL || "/bin/sh");
  const shellPath = await new Promise<string>((resolve) => {
    execFile(shell, ["-ilc", "printf '\\0%s\\0' \"$PATH\""], {
      cwd: home,
      env: { ...process.env, PATH: currentPath || "/usr/bin:/bin:/usr/sbin:/sbin" },
      timeout: 3000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    }, (error, stdout) => {
      resolve(error ? "" : stdout.split("\0")[1] ?? "");
    });
  }).catch(() => "");
  const candidates = [
    "/opt/homebrew/bin", "/opt/homebrew/sbin",
    "/usr/local/bin", "/usr/local/sbin",
    path.join(home, ".cargo/bin"), path.join(home, ".local/bin"),
    "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  ].filter((directory) => {
    try { return fs.statSync(directory).isDirectory(); }
    catch { return false; }
  });
  // Drop empty/relative entries: the server's Resources directory is not a bin dir.
  const entries = [...currentPath.split(":"), ...shellPath.split(":"), ...candidates]
    .filter((entry) => path.posix.isAbsolute(entry));
  return [...new Set(entries)].join(":");
}
