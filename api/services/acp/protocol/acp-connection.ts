// ---------------------------------------------------------------------------
// Shared ACP connection bootstrap.
//
// Encapsulates: spawn an ACP-compatible CLI → Web Streams → ndJsonStream →
// ClientSideConnection. Used by both full dispatch providers and the
// /_internal/acp-generate bridge (lightweight text generation).
// ---------------------------------------------------------------------------

import {
  ClientSideConnection,
  ndJsonStream,
  type AgentCapabilities,
  type Client,
  type InitializeResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { logger } from '../../../lib/logger.js'
import { createClientHandler, type ClientOverrides } from './reverse-handlers.js'
import { CURSOR_CLI_INSTALL_HINT, resolveCursorCliBinary } from '../cursor-cli-resolve.js'

/** Protocol version negotiated with the agent; ACP currently uses integer 1. */
const PROTOCOL_VERSION = 1

/**
 * Spawn command for a local ACP CLI.
 */
export interface AcpSpawnSpec {
  providerId: string
  commandLabel: string
  command: string
  args: string[]
}

function buildCursorSpawnSpec(cli: string): AcpSpawnSpec {
  const isAbsolute = cli.includes('/') || cli.includes('\\')
  if (process.platform === 'win32') {
    const bin = isAbsolute ? cli : `${cli}.cmd`
    return {
      providerId: 'cursor-acp',
      commandLabel: cli,
      command: 'cmd.exe',
      args: ['/c', bin, 'acp'],
    }
  }
  return {
    providerId: 'cursor-acp',
    commandLabel: cli,
    command: cli,
    args: ['acp'],
  }
}

/**
 * Resolve the spawn command for the local Cursor ACP CLI.
 * Probes `cursor-agent`, `agent`, and ~/.local/bin/agent.
 */
export async function resolveCursorSpawnAsync(): Promise<AcpSpawnSpec | null> {
  const cli = await resolveCursorCliBinary()
  if (!cli) return null
  return buildCursorSpawnSpec(cli)
}

/**
 * @deprecated Prefer resolveCursorSpawnAsync(); kept for callers that cannot await.
 */
export function resolveCursorSpawn(): AcpSpawnSpec {
  if (process.platform === 'win32') {
    return {
      providerId: 'cursor-acp',
      commandLabel: 'cursor-agent',
      command: 'cmd.exe',
      args: ['/c', 'cursor-agent.cmd', 'acp'],
    }
  }
  return {
    providerId: 'cursor-acp',
    commandLabel: 'cursor-agent',
    command: 'cursor-agent',
    args: ['acp'],
  }
}

/**
 * Resolve the spawn command for the local OpenCode ACP CLI.
 *
 * OpenCode's ACP command is a JSON-RPC/stdio subprocess. On Windows the npm
 * shim is `opencode.cmd`, so we route through `cmd.exe /c` just like Cursor.
 */
export function resolveOpenCodeSpawn(): AcpSpawnSpec {
  if (process.platform === 'win32') {
    return {
      providerId: 'opencode-acp',
      commandLabel: 'opencode',
      command: 'cmd.exe',
      args: ['/c', 'opencode.cmd', 'acp'],
    }
  }
  return {
    providerId: 'opencode-acp',
    commandLabel: 'opencode',
    command: 'opencode',
    args: ['acp'],
  }
}

export function resolveSpawnForProvider(providerId: string): AcpSpawnSpec {
  if (providerId === 'cursor-acp') return resolveCursorSpawn()
  if (providerId === 'opencode-acp') return resolveOpenCodeSpawn()
  throw new Error(`No ACP subprocess command registered for provider: ${providerId}`)
}

export async function resolveSpawnForProviderAsync(providerId: string): Promise<AcpSpawnSpec> {
  if (providerId === 'cursor-acp') {
    const spec = await resolveCursorSpawnAsync()
    if (!spec) {
      throw new Error(CURSOR_CLI_INSTALL_HINT)
    }
    return spec
  }
  return resolveSpawnForProvider(providerId)
}

export interface AcpConnection {
  conn: ClientSideConnection
  child: ChildProcessWithoutNullStreams
  stderrChunks: string[]
  spawn: AcpSpawnSpec
  /** Kill the child process and clean up. */
  cleanup(): void
}

/**
 * Spawn an ACP CLI and establish an ACP ClientSideConnection.
 *
 * The caller is responsible for calling `cleanup()` when done.
 * The `sessionUpdate` override is required so events flow to the caller.
 */
export function spawnAcpConnection(
  overrides: ClientOverrides,
  spawnSpec: AcpSpawnSpec = resolveOpenCodeSpawn(),
): AcpConnection {
  const { command, args } = spawnSpec
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })

  const stderrChunks: string[] = []
  child.stderr.setEncoding('utf-8')
  child.stderr.on('data', (chunk: string) => {
    stderrChunks.push(chunk)
    logger.debug({ providerId: spawnSpec.providerId, text: chunk.trim() }, '[AcpConnection] stderr')
  })

  const stdoutWeb = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  const stdinWeb = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
  const stream = ndJsonStream(stdinWeb, stdoutWeb)

  const handler: Client = createClientHandler(overrides)
  const conn = new ClientSideConnection(() => handler, stream)

  const cleanup = () => {
    if (!child.killed) {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
  }

  return { conn, child, stderrChunks, spawn: spawnSpec, cleanup }
}

export interface AcpInitResult {
  init: InitializeResponse;
  capabilities: AgentCapabilities;
}

export interface AcpSessionOpenResult {
  acpSessionId: string;
  capabilities: AgentCapabilities;
}

const DEFAULT_CLIENT_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: false },
  terminal: false,
} as const;

/**
 * Run the ACP initialize handshake and return negotiated capabilities.
 */
export async function initializeProtocol(conn: ClientSideConnection): Promise<AcpInitResult> {
  const init = await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: DEFAULT_CLIENT_CAPABILITIES,
  })
  return {
    init,
    capabilities: init.agentCapabilities ?? {},
  }
}

function resolveCwd(cwd?: string): string {
  const resolvedCwd = cwd && cwd.trim().length > 0 ? cwd : process.cwd()
  if (!cwd) {
    logger.warn(
      { fallbackCwd: resolvedCwd },
      '[AcpConnection] session open called without cwd; falling back to process.cwd(). '
        + 'This leaks the host project into the agent context - pass the target workDir.',
    )
  }
  return resolvedCwd
}

export async function createAcpSession(
  conn: ClientSideConnection,
  cwd: string,
): Promise<string> {
  const { sessionId } = await conn.newSession({
    cwd: resolveCwd(cwd),
    mcpServers: [],
  })
  return sessionId
}

export async function loadAcpSession(
  conn: ClientSideConnection,
  acpSessionId: string,
  cwd: string,
): Promise<void> {
  await conn.loadSession({
    sessionId: acpSessionId,
    cwd: resolveCwd(cwd),
    mcpServers: [],
  })
}

export async function resumeAcpSession(
  conn: ClientSideConnection,
  acpSessionId: string,
  cwd: string,
): Promise<void> {
  await conn.resumeSession({
    sessionId: acpSessionId,
    cwd: resolveCwd(cwd),
    mcpServers: [],
  })
}

export async function cancelAcpPrompt(
  conn: ClientSideConnection,
  acpSessionId: string,
): Promise<void> {
  await conn.cancel({ sessionId: acpSessionId })
}

export async function closeAcpSession(
  conn: ClientSideConnection,
  acpSessionId: string,
): Promise<void> {
  if (typeof conn.closeSession === 'function') {
    await conn.closeSession({ sessionId: acpSessionId })
  }
}

/**
 * Open or restore an ACP session on an initialized connection.
 */
export async function openAcpSession(
  conn: ClientSideConnection,
  input: {
    cwd: string;
    acpSessionId?: string | null;
    capabilities: AgentCapabilities;
  },
): Promise<string> {
  if (input.acpSessionId) {
    if (input.capabilities.loadSession) {
      await loadAcpSession(conn, input.acpSessionId, input.cwd)
      return input.acpSessionId
    }
    if (input.capabilities.sessionCapabilities?.resume) {
      await resumeAcpSession(conn, input.acpSessionId, input.cwd)
      return input.acpSessionId
    }
    logger.warn(
      { acpSessionId: input.acpSessionId },
      '[AcpConnection] agent lacks loadSession/resume; creating new ACP session instead',
    )
  }
  return createAcpSession(conn, input.cwd)
}

/**
 * Run the standard ACP initialization handshake.
 * Returns the sessionId for subsequent prompts.
 *
 * IMPORTANT: ``cwd`` is the working directory the remote ACP agent will
 * anchor its filesystem view to. Callers MUST pass the *target project's*
 * path (e.g. ``source.localPath`` for the repo being analyzed) — falling
 * back to ``process.cwd()`` makes the agent treat the Synax repo itself
 * as the target, which silently poisons seed-extraction output with
 * Synax's own feature tree. When no explicit cwd is available we still
 * fall back, but log a warning so the caller gets nudged to fix it.
 */
export async function initializeSession(
  conn: ClientSideConnection,
  cwd?: string,
): Promise<string> {
  const { capabilities } = await initializeProtocol(conn)
  return openAcpSession(conn, { cwd: cwd ?? process.cwd(), capabilities })
}
