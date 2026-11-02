import { describe, expect, it } from 'vitest';
import {
  DRIVER_BROWSER_LAUNCH_BLOCKED,
  DEFAULT_PROFILE_LAUNCH_BLOCKED,
  KEYCHAIN_FREE_ARG,
  applyKeychainPolicy,
  hasIsolatedProfile,
  isChromiumTarget,
  withKeychainFreeArgs,
} from './keychain-policy.js';

describe('Chrome keychain policy', () => {
  it('recognizes Chromium browsers by bundle id or display name', () => {
    expect(isChromiumTarget({ bundle_id: 'com.google.Chrome' })).toBe(true);
    expect(isChromiumTarget({ bundle_id: 'org.chromium.Chromium' })).toBe(true);
    expect(isChromiumTarget({ name: 'Google Chrome' })).toBe(true);
    expect(isChromiumTarget({ name: 'Brave Browser' })).toBe(true);
    expect(isChromiumTarget({ bundle_id: 'com.apple.calculator' })).toBe(false);
    expect(isChromiumTarget({ name: 'Calculator' })).toBe(false);
    expect(isChromiumTarget({})).toBe(false);
  });

  it('keeps the flag single and preserves caller arguments', () => {
    expect(withKeychainFreeArgs(undefined)).toEqual([KEYCHAIN_FREE_ARG]);
    expect(withKeychainFreeArgs(['--lang=zh-CN'])).toEqual(['--lang=zh-CN', KEYCHAIN_FREE_ARG]);
    expect(withKeychainFreeArgs([KEYCHAIN_FREE_ARG])).toEqual([KEYCHAIN_FREE_ARG]);
    expect(withKeychainFreeArgs([42, KEYCHAIN_FREE_ARG])).toEqual([KEYCHAIN_FREE_ARG]);
  });

  it('detects a caller-supplied throwaway profile', () => {
    expect(hasIsolatedProfile({ additional_arguments: ['--user-data-dir=/tmp/p'] })).toBe(true);
    expect(hasIsolatedProfile({ additional_arguments: ['--user-data-dir='] })).toBe(false);
    expect(hasIsolatedProfile({ additional_arguments: ['--lang=zh-CN'] })).toBe(false);
    expect(hasIsolatedProfile({})).toBe(false);
  });

  it('forces the keychain-free flag onto a Chromium launch with its own profile', () => {
    const decision = applyKeychainPolicy('launch_app', {
      bundle_id: 'com.google.Chrome',
      additional_arguments: ['--user-data-dir=/tmp/automation-profile'],
    });
    expect(decision).toEqual({
      allow: true,
      args: {
        bundle_id: 'com.google.Chrome',
        additional_arguments: ['--user-data-dir=/tmp/automation-profile', KEYCHAIN_FREE_ARG],
      },
    });
  });

  it('refuses to reuse the real Chrome profile', () => {
    const decision = applyKeychainPolicy('launch_app', { bundle_id: 'com.google.Chrome' });
    expect(decision).toEqual({ allow: false, message: DEFAULT_PROFILE_LAUNCH_BLOCKED });
  });

  it('leaves non-browser launches untouched', () => {
    const args = { bundle_id: 'com.apple.calculator' };
    expect(applyKeychainPolicy('launch_app', args)).toEqual({ allow: true, args });
  });

  it('refuses driver-owned browser launches', () => {
    const decision = applyKeychainPolicy('browser_prepare', {
      allow_launch: true,
      profile: { mode: 'isolated_new' },
    });
    expect(decision).toEqual({ allow: false, message: DRIVER_BROWSER_LAUNCH_BLOCKED });
  });

  it('keeps attaching to a running browser available', () => {
    const args = { pid: 2551, window_id: 12, strategy: { kind: 'existing_profile' } };
    expect(applyKeychainPolicy('browser_prepare', args)).toEqual({ allow: true, args });
  });

  it('honours the opt-out switch', () => {
    const args = { allow_launch: true };
    expect(applyKeychainPolicy('browser_prepare', args, { allowDriverBrowserLaunch: true })).toEqual(
      { allow: true, args },
    );
  });
});
