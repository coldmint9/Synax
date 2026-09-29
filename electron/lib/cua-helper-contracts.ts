/**
 * Electron-side mirror of the helper contract.
 *
 * Electron compiles from its own `rootDir`, so it cannot import
 * `cua-helper/contracts.ts`. `cua-helper/contracts.test.ts` asserts that these
 * values stay identical to the canonical definitions.
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
export const CUA_HELPER_RESOURCE_DIR = 'cua-helper';

/** Process exit codes the supervisor maps to user-facing guidance. */
export const CUA_EXIT_CODES = {
  permission: 78,
  unavailable: 69,
} as const;
