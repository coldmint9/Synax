import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';
import {
  CUA_GENERATION_FLAG,
  CUA_HELPER_BUNDLE_ID,
  CUA_HELPER_RESOURCE_DIR,
  CUA_SDK_VERSION,
  CUA_VERSION_FLAG,
} from './cua-helper-contracts.js';

const execFileAsync = promisify(execFile);

export { CUA_SDK_VERSION };

export type CuaRuntimeStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'restarting'
  | 'unavailable'
  | 'stopped';

/**
 * Handed to the API sidecar, which spawns the helper as an MCP stdio server.
 * Shape must stay compatible with `api/services/mcp/runtime-cua-config.ts`.
 */
export interface CuaRuntimeConnection {
  generation: string;
  mcp: {
    command: string;
    args: string[];
    environment: Array<{ name: string; value: string }>;
  };
}

export interface CuaHelperLaunch {
  command: string;
  /** Ordered command candidates used for native executable overrides. */
  commandCandidates: string[];
  baseArgs: string[];
  environment: Array<{ name: string; value: string }>;
  /** Driver binary the helper must use; surfaced for early, readable failures. */
  driverPath: string;
  helperRoot: string;
  /** Artifact that must exist when the helper is hosted by another runtime. */
  artifactPath?: string;
}

export interface CuaPermissionStatus {
  accessibility: boolean | null;
  screenRecording: boolean | null;
  error: string | null;
}

function environmentEntries(
  values: Record<string, string | undefined>,
): Array<{ name: string; value: string }> {
  return Object.entries(values)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, value]) => ({ name, value }));
}

export function driverExecutableName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'cua-driver.exe' : 'cua-driver';
}

/**
 * Resolve the standalone helper artifact and the driver binary it must use.
 *
 * Both dev and packaged desktop builds run the tsup-built `.cjs` helper through
 * Electron's Node mode. The helper is shipped in `cua-helper-dist`, which is the
 * resource directory configured by forge; keeping one launch shape avoids a
 * production-only lookup of an artifact that was never packaged.
 */
export function resolveHelperLaunch(options: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
  env: NodeJS.ProcessEnv;
}): CuaHelperLaunch {
  const { platform, isPackaged, appPath, resourcesPath, env } = options;
  const helperRoot = path.join(
    isPackaged ? resourcesPath : appPath,
    CUA_HELPER_RESOURCE_DIR,
  );
  const driverPath = env.SYNAX_CUA_DRIVER_PATH?.trim()
    ? path.resolve(env.SYNAX_CUA_DRIVER_PATH.trim())
    : isPackaged
      ? path.join(resourcesPath, 'cua-driver', driverExecutableName(platform))
      : path.join(appPath, 'dist', 'cua-driver', driverExecutableName(platform));

  const shared = environmentEntries({
    SYNAX_CUA_HELPER_ROOT: helperRoot,
    SYNAX_CUA_BUNDLE_ID: CUA_HELPER_BUNDLE_ID,
    SYNAX_CUA_DRIVER_PATH: driverPath,
  });

  const override = env.SYNAX_CUA_HELPER_PATH?.trim();
  if (override) {
    if (!path.isAbsolute(override))
      throw new Error('SYNAX_CUA_HELPER_PATH must be an absolute path');
    return override.endsWith('.cjs') || override.endsWith('.js')
      ? {
          command: process.execPath,
          commandCandidates: [process.execPath],
          baseArgs: [override],
          environment: environmentEntries({
            ELECTRON_RUN_AS_NODE: '1',
            ...Object.fromEntries(shared.map(({ name, value }) => [name, value])),
          }),
          driverPath,
          helperRoot,
          artifactPath: override,
        }
      : {
          command: override,
          commandCandidates: [override],
          baseArgs: [],
          environment: shared,
          driverPath,
          helperRoot,
        };
  }

  const bundle = path.join(helperRoot, 'cua-helper.cjs');
  return {
    command: process.execPath,
    commandCandidates: [process.execPath],
    baseArgs: [bundle],
    environment: environmentEntries({
      ELECTRON_RUN_AS_NODE: '1',
      ...Object.fromEntries(shared.map(({ name, value }) => [name, value])),
    }),
    driverPath,
    helperRoot,
    artifactPath: bundle,
  };
}

async function assertReadable(target: string, label: string): Promise<void> {
  try {
    await fs.access(
      target,
      process.platform === 'win32' ? constants.F_OK : constants.X_OK,
    );
  } catch {
    throw new Error(`${label} is unavailable: ${target}`);
  }
}

/** Resolve the configured helper command and fail with its exact artifact path. */
async function resolveHelperCommand(launch: CuaHelperLaunch): Promise<string> {
  if (launch.artifactPath) {
    try {
      await fs.access(launch.artifactPath, constants.F_OK);
      return launch.command;
    } catch {
      throw new Error(`Synax CUA helper is unavailable: ${launch.artifactPath}`);
    }
  }
  for (const candidate of launch.commandCandidates) {
    try {
      await fs.access(
        candidate,
        process.platform === 'win32' ? constants.F_OK : constants.X_OK,
      );
      return candidate;
    } catch {
      /* Try the next candidate. */
    }
  }
  throw new Error(
    `Synax CUA helper is unavailable: ${launch.commandCandidates.join(', ')}`,
  );
}

/**
 * Helper supervisor.
 *
 * It owns helper discovery, version agreement and the ephemeral MCP connection
 * metadata. It deliberately does not spawn the helper: the API sidecar owns the
 * MCP stdio session, so the helper's lifetime follows that session. When the
 * sidecar exits, its pipes close, the helper sees EOF and shuts the driver down.
 */
export class CuaRuntimeManager {
  private connection: CuaRuntimeConnection | null = null;
  private pending: Promise<CuaRuntimeConnection | null> | null = null;
  private currentStatus: CuaRuntimeStatus = 'idle';
  private lastError: string | null = null;
  private stopped = false;

  constructor(private readonly onConnection: (connection: CuaRuntimeConnection | null) => void) {}

  status(): { state: CuaRuntimeStatus; error: string | null } {
    return { state: this.currentStatus, error: this.lastError };
  }

  async permissions(): Promise<CuaPermissionStatus> {
    if (process.platform !== 'darwin')
      return { accessibility: null, screenRecording: null, error: null };
    try {
      const launch = resolveHelperLaunch({
        platform: process.platform,
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        env: process.env,
      });
      const result = await execFileAsync(
        launch.command,
        [...launch.baseArgs, '--permissions'],
        {
          timeout: 5_000,
          maxBuffer: 64 * 1024,
          env: {
            ...process.env,
            ...Object.fromEntries(launch.environment.map(({ name, value }) => [name, value])),
          },
        },
      );
      const parsed = JSON.parse(result.stdout.trim()) as Partial<CuaPermissionStatus>;
      return {
        accessibility: typeof parsed.accessibility === 'boolean' ? parsed.accessibility : null,
        screenRecording: typeof parsed.screenRecording === 'boolean' ? parsed.screenRecording : null,
        error: null,
      };
    } catch (error) {
      return {
        accessibility: null,
        screenRecording: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  start(): Promise<CuaRuntimeConnection | null> {
    if (this.stopped) return Promise.resolve(null);
    if (this.connection) return Promise.resolve(this.connection);
    if (this.pending) return this.pending;
    this.currentStatus = 'starting';
    this.pending = this.launch()
      .catch((error: unknown) => {
        this.currentStatus = 'unavailable';
        this.lastError = error instanceof Error ? error.message : String(error);
        console.warn('[cua] helper unavailable:', this.lastError);
        return null;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  private async launch(): Promise<CuaRuntimeConnection> {
    const launch = resolveHelperLaunch({
      platform: process.platform,
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: (process as NodeJS.Process & { resourcesPath?: string })
        .resourcesPath ?? path.join(app.getAppPath(), 'resources'),
      env: process.env,
    });
    const command = await resolveHelperCommand(launch);
    await assertReadable(launch.driverPath, 'Cua Driver binary');
    await this.assertHelperVersion(command, launch);
    if (this.stopped) throw new Error('Cua helper supervisor stopped during startup');

    const generation = randomUUID();
    const connection: CuaRuntimeConnection = {
      generation,
      mcp: {
        command,
        args: [...launch.baseArgs, CUA_GENERATION_FLAG, generation],
        environment: launch.environment,
      },
    };
    this.connection = connection;
    this.currentStatus = 'ready';
    this.lastError = null;
    this.onConnection(connection);
    return connection;
  }

  /** Fail early and legibly when the helper artifact does not match the SDK. */
  private async assertHelperVersion(
    command: string,
    launch: CuaHelperLaunch,
  ): Promise<void> {
    let stdout: string;
    try {
      const result = await execFileAsync(
        command,
        [...launch.baseArgs, CUA_VERSION_FLAG],
        {
          timeout: 5_000,
          env: {
            ...process.env,
            ...Object.fromEntries(
              launch.environment.map(({ name, value }) => [name, value]),
            ),
          },
        },
      );
      stdout = result.stdout;
    } catch (error) {
      throw new Error(
        `Synax CUA helper failed to report its version: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const found = /\bsynax-cua\s+(\d+\.\d+\.\d+)\b/.exec(stdout)?.[1];
    if (found !== CUA_SDK_VERSION)
      throw new Error(
        `Synax CUA helper ${found ?? 'unknown'} is incompatible with Synax ${CUA_SDK_VERSION}`,
      );
  }

  /** Re-issue a fresh connection so the sidecar spawns a new helper process. */
  async restart(): Promise<CuaRuntimeConnection | null> {
    if (this.stopped) return null;
    this.currentStatus = 'restarting';
    this.connection = null;
    this.onConnection(null);
    await this.pending;
    if (this.stopped) return null;
    return this.start();
  }

  /**
   * Called when the sidecar reports that the helper's MCP session ended, so a
   * crashed helper is visible instead of pretending Computer Use still works.
   */
  markUnavailable(error: string): void {
    if (this.stopped || !this.connection) return;
    this.connection = null;
    this.currentStatus = 'unavailable';
    this.lastError = error;
    this.onConnection(null);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.connection = null;
    this.onConnection(null);
    await this.pending;
    this.currentStatus = 'stopped';
  }
}
