#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import {
  CUA_EXIT_CODES,
  CUA_GENERATION_FLAG,
  CUA_HELPER_BUNDLE_ID,
  CUA_SDK_VERSION,
  CUA_VERSION_FLAG,
} from './contracts.js';
import { resolveDriverExecutable } from './driver-path.js';
import { generationEnvironment, startCuaHelperBridge } from './mcp-bridge.js';

/**
 * Standalone Computer Use helper.
 *
 * Synax spawns this process and speaks MCP stdio to it. Everything that needs a
 * desktop permission operation lives here: the CUA embedded host, the native
 * driver daemon, and the macOS Accessibility / Screen Recording requests. Synax
 * itself never loads the CUA SDK in its API sidecar, so helper failures stay
 * isolated from the backend.
 *
 * Contract with the supervisor:
 * - stdout carries MCP stdio frames only; diagnostics go to stderr.
 * - `--version` prints `synax-cua <sdk version>` and exits.
 * - Permission failure and driver failure exit non-zero with a readable message.
 */

/**
 * The helper ships as a CJS bundle and may run hosted by Node or as a standalone
 * executable, so `import.meta` is unavailable. The supervisor always passes
 * `SYNAX_CUA_HELPER_ROOT`; this fallback keeps a hand-launched helper working.
 */
function defaultHelperRoot(): string {
  const entry = process.argv[1];
  if (entry && !entry.startsWith('-')) return path.dirname(path.resolve(entry));
  return path.dirname(process.execPath);
}

/** Keep stdout reserved for the MCP transport. */
function log(message: string): void {
  process.stderr.write(`[synax-cua] ${message}\n`);
}

export function parseGeneration(argv: string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== CUA_GENERATION_FLAG) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) return null;
    return value.slice(0, 128);
  }
  return null;
}

type HostLike = {
  start(): Promise<{ generation: string; mcp: { command: string; args: string[]; environment: Array<{ name: string; value: string }> } }>;
  stop(): Promise<void>;
  waitForExit(generation: string): Promise<unknown>;
  uniffiDestroy(): void;
};

type SdkModule = {
  EmbeddedCuaDriverHost: new (binaryPath: string, hostBundleId: string) => HostLike;
  requestMacOsPermissions: () => { accessibility: boolean; screenRecording: boolean };
  currentMacOsPermissionStatus?: () => { accessibility: boolean; screenRecording: boolean };
};

export type HelperPermissionStatus = {
  accessibility: boolean | null;
  screenRecording: boolean | null;
};

export function readHelperPermissionStatus(
  sdk: Pick<SdkModule, 'currentMacOsPermissionStatus'>,
  platform: NodeJS.Platform,
): HelperPermissionStatus {
  if (platform !== 'darwin' || !sdk.currentMacOsPermissionStatus)
    return { accessibility: null, screenRecording: null };
  try {
    return sdk.currentMacOsPermissionStatus();
  } catch {
    return { accessibility: null, screenRecording: null };
  }
}

function describePermissions(status: { accessibility: boolean; screenRecording: boolean }): string {
  const missing = [
    !status.accessibility ? 'Accessibility' : null,
    !status.screenRecording ? 'Screen Recording' : null,
  ].filter((value): value is string => value !== null);
  return (
    `Grant Synax ${missing.join(' and ')} permission in ` +
    'macOS System Settings > Privacy & Security, then retry Computer Use. ' +
    'Synax itself does not need these permissions.'
  );
}

/**
 * macOS attributes desktop permissions to the host application. Requesting from this
 * process makes the packaged Synax identity visible in the System Settings lists.
 */
export function requestHelperPermissions(
  sdk: Pick<SdkModule, 'requestMacOsPermissions'>,
  platform: NodeJS.Platform,
): void {
  if (platform !== 'darwin') return;
  const status = sdk.requestMacOsPermissions();
  if (!status.accessibility || !status.screenRecording)
    throw new Error(describePermissions(status));
}

export async function loadSdk(): Promise<SdkModule> {
  // Resolve the SDK next to this helper so the driver binary and the SDK stay a
  // version-locked pair, independent of any other Synax install.
  return (await import('@trycua/cua-driver')) as SdkModule;
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes(CUA_VERSION_FLAG)) {
    process.stdout.write(`synax-cua ${CUA_SDK_VERSION}\n`);
    return;
  }
  if (argv.includes('--permissions')) {
    const sdk = await loadSdk();
    process.stdout.write(`${JSON.stringify(readHelperPermissionStatus(sdk, process.platform))}\n`);
    return;
  }

  const helperRoot = process.env.SYNAX_CUA_HELPER_ROOT?.trim() || defaultHelperRoot();
  const bundleId = process.env.SYNAX_CUA_BUNDLE_ID?.trim() || CUA_HELPER_BUNDLE_ID;
  const generationOverride = parseGeneration(argv);

  const driver = await resolveDriverExecutable({
    platform: process.platform,
    helperRoot,
    override: process.env.SYNAX_CUA_DRIVER_PATH,
  });
  log(`driver ready: ${driver}`);

  const sdk = await loadSdk();
  requestHelperPermissions(sdk, process.platform);

  const host = new sdk.EmbeddedCuaDriverHost(driver, bundleId);
  let bridge: Awaited<ReturnType<typeof startCuaHelperBridge>> | null = null;
  let stopping = false;

  const shutdown = async (code: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    // A signal/EOF can arrive while the bridge is connecting. Wait until it
    // has either handed back its resources or cleaned up its failed startup.
    await startup.catch(() => undefined);
    try {
      await bridge?.close();
    } catch (error) {
      log(`bridge close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await host.stop();
    } catch (error) {
      log(`host stop failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      host.uniffiDestroy();
    }
    process.exit(code);
  };

  // MCP frames arrive on stdin; EOF means the owning Synax session went away.
  process.stdin.on('end', () => void shutdown(0));
  process.stdin.on('close', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));

  const startup = (async () => {
    const started = await host.start();
    const generation = generationOverride ?? started.generation;
    log(`host started: generation=${generation}`);
    // Avoid opening a new transport after its owner has already disconnected.
    if (!stopping) {
      bridge = await startCuaHelperBridge({
        mcp: started.mcp,
        generation,
        environment: generationEnvironment(generation),
        onDriverStderr: log,
      });
      log('mcp bridge ready on stdio');
    }
    return started;
  })();
  if (process.stdin.readableEnded || process.stdin.destroyed) void shutdown(0);

  let started: Awaited<ReturnType<HostLike['start']>>;
  try {
    started = await startup;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`startup failed: ${message}`);
    await shutdown(/permission/i.test(message) ? CUA_EXIT_CODES.permission : CUA_EXIT_CODES.unavailable);
    return;
  }
  if (stopping) return;

  void host
    .waitForExit(started.generation)
    .then(() => shutdown(CUA_EXIT_CODES.unavailable))
    .catch((error: unknown) => {
      log(`exit monitor failed: ${error instanceof Error ? error.message : String(error)}`);
    });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (invokedDirectly) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log(message);
    const permissionDenied = /permission/i.test(message);
    process.exit(
      permissionDenied ? CUA_EXIT_CODES.permission : CUA_EXIT_CODES.unavailable,
    );
  });
}
