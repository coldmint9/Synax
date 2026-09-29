import { describe, expect, it } from 'vitest';
import * as helper from './contracts.js';
import * as electronMirror from '../electron/lib/cua-helper-contracts.js';

/**
 * Electron cannot import the helper's source (different TS rootDir), so the few
 * shared values are mirrored. This test is the guard that keeps them identical.
 */
describe('helper contract mirror', () => {
  it('keeps the Electron mirror in sync with the canonical helper contract', () => {
    expect(electronMirror.CUA_HELPER_BUNDLE_ID).toBe(helper.CUA_HELPER_BUNDLE_ID);
    expect(electronMirror.CUA_SDK_VERSION).toBe(helper.CUA_SDK_VERSION);
    expect(electronMirror.CUA_GENERATION_FLAG).toBe(helper.CUA_GENERATION_FLAG);
    expect(electronMirror.CUA_VERSION_FLAG).toBe(helper.CUA_VERSION_FLAG);
    expect(electronMirror.CUA_HELPER_MACOS_APP_NAME).toBe(
      helper.CUA_HELPER_MACOS_APP_NAME,
    );
    expect(electronMirror.CUA_HELPER_RESOURCE_DIR).toBe(helper.CUA_HELPER_RESOURCE_DIR);
    expect(electronMirror.CUA_EXIT_CODES).toEqual(helper.CUA_EXIT_CODES);
  });

  it('names the helper per platform and owns an independent macOS bundle id', () => {
    expect(helper.cuaHelperExecutableName('darwin')).toBe('synax-cua');
    expect(helper.cuaHelperExecutableName('linux')).toBe('synax-cua');
    expect(helper.cuaHelperExecutableName('win32')).toBe('synax-cua.exe');
    expect(helper.CUA_HELPER_BUNDLE_ID).not.toBe('com.Synax.desktop');
  });
});
