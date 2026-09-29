/**
 * Canonical contract between the Synax desktop supervisor and the standalone
 * `synax-cua` helper process.
 *
 * The helper is a separate OS process with its own permission identity. Synax
 * only ever talks to it over MCP stdio; this file is the single source of truth
 * for the values both sides must agree on.
 *
 * `electron/lib/cua-helper-contracts.ts` mirrors the values Electron needs
 * (Electron compiles from its own rootDir and cannot import across roots).
 * `cua-helper/contracts.test.ts` fails if the two copies drift.
 */

/** macOS bundle identifier owned by the helper app, not by Synax. */
export const CUA_HELPER_BUNDLE_ID = 'com.Synax.cua';

/** CUA Driver (SDK + binary) version the helper is built against. */
export const CUA_SDK_VERSION = '0.30.2';

/** CLI flag carrying the supervisor-assigned connection generation. */
export const CUA_GENERATION_FLAG = '--generation';

/** CLI flag that prints `synax-cua <version>` and exits. */
export const CUA_VERSION_FLAG = '--version';

/** Executable/file name of the helper on the current platform. */
export function cuaHelperExecutableName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'synax-cua.exe' : 'synax-cua';
}

/** macOS helper app bundle name shipped inside the Synax resources directory. */
export const CUA_HELPER_MACOS_APP_NAME = 'Synax CUA.app';

/** Resource-relative directory that owns the packaged helper artifact. */
export const CUA_HELPER_RESOURCE_DIR = 'cua-helper-dist';

/** Process exit codes the supervisor maps to user-facing guidance. */
export const CUA_EXIT_CODES = {
  /** Permission denied: the user must grant helper permissions in System Settings. */
  permission: 78,
  /** Helper or driver is unavailable (missing, incompatible, or failed to start). */
  unavailable: 69,
} as const;
