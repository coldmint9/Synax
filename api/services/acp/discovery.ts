import { spawn } from 'node:child_process'
import type { AcpProvider } from './registry/provider-registry.js'
import { CURSOR_CLI_INSTALL_HINT, resolveCursorCliBinary } from './cursor-cli-resolve.js'
import { resolveSpawnForProviderAsync, spawnAcpConnection } from './protocol/acp-connection.js'

const ACP_PROTOCOL_VERSION = 1

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

      const handshake = await probeHandshake(provider.id)
      return {
        id: provider.id,
        label: provider.label,
        description: provider.description,
        command: resolvedCommand,
        status: handshake.ok ? 'available' : 'failed',
        installed: true,
        handshakeOk: handshake.ok,
        selected: provider.id === selectedProviderId,
        compatibility: meta?.compatibility ?? 'ACP-compatible provider.',
        ...(handshake.error ? { error: handshake.error } : {}),
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

async function probeHandshake(providerId: string): Promise<{ ok: boolean; error?: string }> {
  let conn: ReturnType<typeof spawnAcpConnection> | undefined
  try {
    const spawnSpec = await resolveSpawnForProviderAsync(providerId)
    conn = spawnAcpConnection({ async sessionUpdate() {} }, spawnSpec)
    await Promise.race([
      conn.conn.initialize({
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: false },
          terminal: false,
        },
      }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('ACP initialize timed out')), 3500)),
      new Promise<never>((_resolve, reject) => {
        conn!.child.once('error', reject)
        conn!.child.once('exit', (code, signal) => {
          if (code !== 0 && code !== null) reject(new Error(`process exited with code ${code}${signal ? ` (${signal})` : ''}`))
        })
      }),
    ])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    conn?.cleanup()
  }
}
