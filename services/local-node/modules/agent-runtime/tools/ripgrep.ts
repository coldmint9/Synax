import fs from "node:fs";
import { runCommand } from "./exec-async.js";

/**
 * Resolve the ripgrep binary shipped with Synax.
 *
 * The universal package contains binaries for every supported desktop
 * platform/architecture. This intentionally does not search PATH: a Synax
 * installation must behave the same whether or not the host has ripgrep.
 * SYNAX_RG_PATH remains available as an explicit developer/test override.
 */

const PROBE_TIMEOUT_MS = 3000;
const PACKAGED_RIPGREP_PACKAGE = "@vscode/ripgrep-universal";

export const RIPGREP_MISSING_HELP =
  "Synax's bundled ripgrep could not be started. The text search will fall back to grep; " +
  "if that also fails, reinstall Synax or set SYNAX_RG_PATH to a compatible rg binary.";

interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  /** Test hook and an escape hatch for packagers that relocate server-dist. */
  packagedPath?: string;
}

async function packagedRipgrepPath(): Promise<string | null> {
  try {
    const mod = (await import(PACKAGED_RIPGREP_PACKAGE)) as {
      rgPath?: string;
      binPathFor?: (options: { os: NodeJS.Platform; arch: string }) => string;
    };
    // Avoid npm_config_arch leaking into packaged app runtime selection.
    if (mod.binPathFor)
      return mod.binPathFor({ os: process.platform, arch: process.arch });
    return typeof mod.rgPath === "string" ? mod.rgPath : null;
  } catch {
    return null;
  }
}

async function probeRipgrep(candidate: string): Promise<boolean> {
  const check = await runCommand(candidate, ["--version"], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return !check.error && check.status === 0;
}

/** Resolve the bundled ripgrep binary path; `null` when it cannot run. */
export async function resolveRipgrepBinary(
  options: ResolveOptions = {},
): Promise<string | null> {
  const override = options.env?.SYNAX_RG_PATH ?? process.env.SYNAX_RG_PATH;
  if (override && (await probeRipgrep(override))) return override;

  const packaged = options.packagedPath ?? (await packagedRipgrepPath());
  if (packaged) {
    try {
      if (
        !fs.statSync(packaged).isDirectory() &&
        (await probeRipgrep(packaged))
      ) {
        return packaged;
      }
    } catch {
      /* Continue to the grep fallback. */
    }
  }

  return null;
}

let cachedResolution: Promise<string | null> | null = null;

/** Cached per-process wrapper around {@link resolveRipgrepBinary}. */
export function resolveRipgrep(): Promise<string | null> {
  if (!cachedResolution)
    cachedResolution = resolveRipgrepBinary().catch(() => null);
  return cachedResolution;
}

/** Test hook: forget the cached resolution. */
export function resetRipgrepResolutionForTests(): void {
  cachedResolution = null;
}
