import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./exec-async.js";

/**
 * Shared ripgrep binary resolution.
 *
 * The desktop app is launched by the OS shell-less GUI context (Finder/Dock
 * on macOS), which hands Electron a minimal PATH such as
 * `/usr/bin:/bin:/usr/sbin:/sbin`. Package managers that install ripgrep
 * (Homebrew on Apple Silicon, cargo, snap) live outside that PATH, so
 * spawning `rg` by name fails with ENOENT even though ripgrep is installed.
 *
 * Tools that need ripgrep resolve an absolute binary path here instead of
 * relying on PATH alone. Resolution order:
 *   1. `SYNAX_RG_PATH` env override (absolute path to the rg binary),
 *   2. `rg` found through the current PATH,
 *   3. well-known install locations (home-relative first, then absolute).
 *
 * Candidates are validated once with `rg --version`; the winning path is
 * cached for the lifetime of the process.
 */

const PROBE_TIMEOUT_MS = 3000;

export const RIPGREP_MISSING_HELP =
  "ripgrep (rg) could not be found on PATH or in common install locations " +
  "(/opt/homebrew/bin, /usr/local/bin, ~/.cargo/bin). Install ripgrep " +
  "(https://github.com/BurntSushi/ripgrep#installation) or set SYNAX_RG_PATH " +
  "to the rg binary, then retry.";

interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

function homeRelativeRipgrepPaths(homeDir: string): string[] {
  return [
    path.join(homeDir, ".cargo", "bin", "rg"),
    path.join(homeDir, ".local", "bin", "rg"),
  ];
}

function wellKnownRipgrepPaths(): string[] {
  if (process.platform === "win32") return [];
  return [
    "/opt/homebrew/bin/rg",
    "/usr/local/bin/rg",
    "/usr/bin/rg",
    "/bin/rg",
    "/snap/bin/rg",
  ];
}

async function probeRipgrep(candidate: string): Promise<boolean> {
  const check = await runCommand(candidate, ["--version"], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return !check.error && check.status === 0;
}

/** Resolve the ripgrep binary path; `null` when no candidate works. */
export async function resolveRipgrepBinary(
  options: ResolveOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();

  const override = env.SYNAX_RG_PATH;
  if (override && (await probeRipgrep(override))) return override;

  if (await probeRipgrep("rg")) return "rg";

  for (const candidate of [
    ...homeRelativeRipgrepPaths(homeDir),
    ...wellKnownRipgrepPaths(),
  ]) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) continue;
    } catch {
      continue;
    }
    if (await probeRipgrep(candidate)) return candidate;
  }

  return null;
}

let cachedResolution: Promise<string | null> | null = null;

/** Cached per-process wrapper around {@link resolveRipgrepBinary}. */
export function resolveRipgrep(): Promise<string | null> {
  if (!cachedResolution) {
    cachedResolution = resolveRipgrepBinary().catch(() => null);
  }
  return cachedResolution;
}

/** Test hook: forget the cached resolution. */
export function resetRipgrepResolutionForTests(): void {
  cachedResolution = null;
}
