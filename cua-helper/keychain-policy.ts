/**
 * Keychain policy for Chrome launches made through the Cua driver.
 *
 * Chromium keeps its safe-storage key in the macOS Keychain. A Chrome process
 * started by another process (agent shell, Cua helper) has no launch-context
 * Keychain, so that store fails and macOS raises
 * 「找不到用于储存"Chrome"的钥匙串」 on every launch. `--use-mock-keychain` is
 * the only launch flag that suppresses it: verified on macOS 27 / Chrome 155,
 * driver-style launches prompt without the flag and stay silent with it.
 *
 * The driver builds the argv of the browsers it launches itself, so this policy
 * injects the flag into `launch_app` and refuses the driver-owned browser launch
 * whose argv Synax cannot reach.
 */

export const KEYCHAIN_FREE_ARG = '--use-mock-keychain';

/** Opt-out switch for users who accept the Keychain dialog. */
export const ALLOW_DRIVER_BROWSER_LAUNCH_ENV = 'SYNAX_CUA_ALLOW_BROWSER_LAUNCH';

/** macOS bundle identifiers of the Chromium-based browsers the driver launches. */
export const CHROMIUM_BUNDLE_IDS: readonly string[] = [
  'com.google.Chrome',
  'com.google.Chrome.beta',
  'com.google.Chrome.canary',
  'com.google.Chrome.dev',
  'com.microsoft.edgemac',
  'com.microsoft.edgemac.Beta',
  'org.chromium.Chromium',
  'com.brave.Browser',
  'com.brave.Browser.beta',
];

/** Display-name fallback for callers that pass `name` instead of `bundle_id`. */
const CHROMIUM_NAME = /google chrome|chrome|chromium|microsoft edge|brave/i;

export const DRIVER_BROWSER_LAUNCH_BLOCKED = [
  'Driver-owned browser launch refused: the driver starts that Chrome itself, and a Chrome started by another process stores its safe-storage key in the macOS Keychain, which raises 「找不到用于储存"Chrome"的钥匙串」 on every launch.',
  'Attach to a browser that is already running instead (browser_prepare with pid and no allow_launch), or use the browser.* tools for isolated web automation.',
  `Set ${ALLOW_DRIVER_BROWSER_LAUNCH_ENV}=1 to re-enable driver-owned launches.`,
].join(' ');

export const DEFAULT_PROFILE_LAUNCH_BLOCKED = [
  'Chrome launch refused: without its own --user-data-dir this reuses the real profile, whose cookies and passwords are encrypted with the Keychain key.',
  'A Chrome started by Synax has no launch-context Keychain, so it raises 「找不到用于储存"Chrome"的钥匙串」, and forcing the mock keychain would leave the existing profile data unreadable.',
  'Use the browser.* tools for isolated web automation, or open Chrome yourself and let browser_prepare attach with its pid.',
].join(' ');

export interface KeychainPolicyOptions {
  /** Allows the driver to launch and own its own browser again. */
  allowDriverBrowserLaunch?: boolean;
}

export type KeychainDecision =
  | { allow: true; args: Record<string, unknown> }
  | { allow: false; message: string };

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const USER_DATA_DIR_PREFIX = '--user-data-dir=';

function additionalArgs(args: Record<string, unknown>): string[] {
  const value = args.additional_arguments;
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** True when a launch_app call targets a Chromium-based browser. */
export function isChromiumTarget(args: Record<string, unknown>): boolean {
  const bundleId = text(args.bundle_id);
  if (bundleId) return CHROMIUM_BUNDLE_IDS.includes(bundleId) || /chrom/i.test(bundleId);
  const name = text(args.name);
  return name.length > 0 && CHROMIUM_NAME.test(name);
}

/** True when the caller already points the browser at a throwaway profile. */
export function hasIsolatedProfile(args: Record<string, unknown>): boolean {
  return additionalArgs(args).some(
    (arg) => arg.startsWith(USER_DATA_DIR_PREFIX) && arg.length > USER_DATA_DIR_PREFIX.length,
  );
}

/** Appends the keychain-free flag once, keeping any caller-supplied arguments. */
export function withKeychainFreeArgs(existing: unknown): string[] {
  const args = Array.isArray(existing)
    ? existing.filter((value): value is string => typeof value === 'string')
    : [];
  return args.includes(KEYCHAIN_FREE_ARG) ? args : [...args, KEYCHAIN_FREE_ARG];
}

/** Decides whether one driver tool call may run, and with which arguments. */
export function applyKeychainPolicy(
  tool: string,
  args: Record<string, unknown>,
  options: KeychainPolicyOptions = {},
): KeychainDecision {
  if (tool === 'launch_app' && isChromiumTarget(args)) {
    if (!hasIsolatedProfile(args)) return { allow: false, message: DEFAULT_PROFILE_LAUNCH_BLOCKED };
    return {
      allow: true,
      args: {
        ...args,
        additional_arguments: withKeychainFreeArgs(args.additional_arguments),
      },
    };
  }
  if (
    tool === 'browser_prepare' &&
    args.allow_launch === true &&
    !options.allowDriverBrowserLaunch
  )
    return { allow: false, message: DRIVER_BROWSER_LAUNCH_BLOCKED };
  return { allow: true, args };
}
