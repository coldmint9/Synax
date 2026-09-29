import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CUA_SDK_VERSION } from './contracts.js';

const execFileAsync = promisify(execFile);

export function driverExecutableName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'cua-driver.exe' : 'cua-driver';
}

/**
 * Candidate locations for the version-locked CUA Driver binary.
 *
 * The supervisor normally passes an absolute `SYNAX_CUA_DRIVER_PATH`, because it
 * is the only party that knows Electron's resources layout. The relative
 * candidates keep the helper usable when it is launched by hand during
 * development or by a future non-Electron host.
 */
export function driverCandidates(options: {
  platform: NodeJS.Platform;
  helperRoot: string;
  override?: string;
}): string[] {
  const { platform, helperRoot, override } = options;
  if (override) return [override];
  const executable = driverExecutableName(platform);
  return [
    path.join(helperRoot, 'cua-driver', executable),
    path.join(helperRoot, '..', 'cua-driver', executable),
    // macOS helper app bundle: Synax CUA.app/Contents/MacOS -> Contents/Resources
    path.join(helperRoot, '..', 'Resources', 'cua-driver', executable),
  ];
}

export async function readDriverVersion(executable: string): Promise<string | null> {
  const { stdout } = await execFileAsync(executable, ['--version'], { timeout: 5_000 });
  return /\bcua-driver\s+(\d+\.\d+\.\d+)\b/.exec(stdout)?.[1] ?? null;
}

/**
 * Resolve a driver binary whose version matches the SDK the helper links against.
 * An unrelated global `cua-driver` is intentionally never used: SDK and driver are
 * a version-locked pair, and an older daemon degrades native window observations.
 */
export async function resolveDriverExecutable(options: {
  platform: NodeJS.Platform;
  helperRoot: string;
  override?: string;
}): Promise<string> {
  const override = options.override?.trim();
  if (override && !path.isAbsolute(override))
    throw new Error('SYNAX_CUA_DRIVER_PATH must be an absolute path');
  const candidates = driverCandidates({ ...options, override: override || undefined });
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      await fs.access(
        candidate,
        options.platform === 'win32' ? constants.F_OK : constants.X_OK,
      );
      const found = await readDriverVersion(candidate);
      if (found !== CUA_SDK_VERSION) {
        lastError = new Error(
          `Cua Driver ${found ?? 'unknown'} is incompatible with Synax CUA helper ${CUA_SDK_VERSION}`,
        );
        continue;
      }
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Unable to find Cua Driver ${CUA_SDK_VERSION}. Set SYNAX_CUA_DRIVER_PATH to a matching executable.` +
      (lastError instanceof Error ? ` Last error: ${lastError.message}` : ''),
  );
}
