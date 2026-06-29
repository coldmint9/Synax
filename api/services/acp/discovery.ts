import { spawn } from 'node:child_process'
import type { AcpProvider } from './registry/provider-registry.js'
import { mapSessionModels, type AcpCatalogModel } from './acp-model-catalog.js'
import { CURSOR_CLI_INSTALL_HINT, resolveCursorCliBinary } from './cursor-cli-resolve.js'
import {
  closeAcpSession,
  createAcpSession,
  initializeProtocol,
  resolveSpawnForProviderAsync,
  spawnAcpConnection,
} from './protocol/acp-connection.js'

const PROBE_TIMEOUT_MS = 12_000

export interface AcpDiscoveryResult {
  id: string
  label: string
  description?: string
  command: string
  status: 'available' | 'installed' | 'missing' | 'failed'
  installed: boolean
  handshakeOk: boolean
  selected: boolean
  compatibility: string
  error?: string
  models?: AcpCatalogModel[]
}

const COMMANDS: Record<string, { commandName: string; windowsName: string; compatibility: string }> = {
  'opencode-acp': {
    commandName: 'opencode',
    windowsName: 'opencode.cmd',
    compatibility: '',
  },
  'cursor-acp': {
    commandName: 'cursor-agent',
    windowsName: 'cursor-agent.cmd',
    compatibility: 'Requires Cursor CLI (`agent` or `cursor-agent`). Install: curl https://cursor.com/install -fsS | bash',
  },
}

export async function discoverAcpProviders(
  providers: AcpProvider[],
  selectedProviderId: string,
): Promise<AcpDiscoveryResult[]> {
  return Promise.all(
    providers.map(async (provider) => {
      const meta = COMMANDS[provider.id]
      const command = meta?.commandName ?? provider.id
      let installed = false
      let resolvedCommand = command

      if (provider.id === 'cursor-acp') {
        const cli = await resolveCursorCliBinary()
        installed = Boolean(cli)
        resolvedCommand = cli ?? 'agent | cursor-agent'
      } else if (meta) {
        installed = await commandExists(meta)
      }

      if (!installed) {
        return {
          id: provider.id,
          label: provider.label,
          description: provider.description,
          command: resolvedCommand,
          status: 'missing',
          installed: false,
          handshakeOk: false,
          selected: provider.id === selectedProviderId,
          compatibility: meta?.compatibility ?? '未配置检测命令。',
          error: provider.id === 'cursor-acp'
            ? CURSOR_CLI_INSTALL_HINT
            : `${command} CLI not found in PATH`,
        }
      }

      const probe = await probeProvider(provider.id)
      return {
        id: provider.id,
        label: provider.label,
        description: provider.description,
        command: resolvedCommand,
        status: probe.ok ? 'available' : 'failed',
        installed: true,
        handshakeOk: probe.ok,
        selected: provider.id === selectedProviderId,
        compatibility: meta?.compatibility ?? 'ACP-compatible provider.',
        ...(probe.models?.length ? { models: probe.models } : {}),
        ...(probe.error ? { error: probe.error } : {}),
      }
    }),
  )
}

function commandExists(meta: { commandName: string; windowsName: string }): Promise<boolean> {
  const command = process.platform === 'win32' ? 'cmd.exe' : 'sh'
  const args = process.platform === 'win32'
    ? ['/c', 'where', meta.windowsName]
    : ['-lc', `command -v ${meta.commandName}`]
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.once('error', () => resolve(false))
    child.once('exit', (code) => resolve(code === 0))
  })
}

async function probeProvider(providerId: string): Promise<{
  ok: boolean
  error?: string
  models?: AcpCatalogModel[]
}> {
  let conn: ReturnType<typeof spawnAcpConnection> | undefined
  let probeSessionId: string | undefined
  try {
    const spawnSpec = await resolveSpawnForProviderAsync(providerId)
    conn = spawnAcpConnection({ async sessionUpdate() {} }, spawnSpec)
    await Promise.race([
      initializeProtocol(conn.conn),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('ACP initialize timed out')), PROBE_TIMEOUT_MS)),
      new Promise<never>((_resolve, reject) => {
        conn!.child.once('error', reject)
        conn!.child.once('exit', (code, signal) => {
          if (code !== 0 && code !== null) reject(new Error(`process exited with code ${code}${signal ? ` (${signal})` : ''}`))
        })
      }),
    ])
    const session = await Promise.race([
      createAcpSession(conn.conn, process.cwd()),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('ACP newSession timed out')), PROBE_TIMEOUT_MS)),
    ])
    probeSessionId = session.sessionId
    const models = mapSessionModels(session.models)
    return {
      ok: true,
      ...(models.length > 0 ? { models } : {}),
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (conn && probeSessionId) {
      try {
        await closeAcpSession(conn.conn, probeSessionId)
      } catch {
        // ignore probe cleanup errors
      }
    }
    conn?.cleanup()
  }
}
