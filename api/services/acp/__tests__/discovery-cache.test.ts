import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../cursor-cli-resolve.js', () => ({
  CURSOR_CLI_INSTALL_HINT: 'install cursor',
  resolveCursorCliBinary: vi.fn(async () => null),
}))

vi.mock('../protocol/acp-connection.js', () => ({
  closeAcpSession: vi.fn(),
  createAcpSession: vi.fn(),
  initializeProtocol: vi.fn(),
  resolveSpawnForProviderAsync: vi.fn(),
  spawnAcpConnection: vi.fn(),
}))

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import {
  discoverAcpProviders,
  resetAcpDiscoveryCacheForTests,
} from '../discovery.js'

/** Fake child that reports an immediate spawn error (binary not found). */
function spawnErrorChild(): unknown {
  return {
    once(event: string, callback: (...args: unknown[]) => void) {
      if (event === 'error') queueMicrotask(() => callback(new Error('ENOENT')))
    },
    kill() {},
  }
}

describe('discoverAcpProviders cache', () => {
  beforeEach(() => {
    resetAcpDiscoveryCacheForTests()
    spawnMock.mockImplementation(spawnErrorChild)
  })

  it('reuses cached results for concurrent and subsequent calls', async () => {
    const providers = [
      { id: 'cursor-acp', label: 'Cursor', description: 'Cursor ACP' },
      { id: 'opencode-acp', label: 'OpenCode', description: 'OpenCode ACP' },
    ] as never[]

    const first = discoverAcpProviders(providers, 'opencode-acp')
    const second = discoverAcpProviders(providers, 'opencode-acp')
    const [a, b] = await Promise.all([first, second])

    expect(a).toEqual(b)
    expect(a.map((item) => item.id).sort()).toEqual(['cursor-acp', 'opencode-acp'])

    const third = await discoverAcpProviders(providers, 'opencode-acp')
    expect(third).toEqual(a)
  })

  it('hides Windows command probes', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      await discoverAcpProviders([
        { id: 'opencode-acp', label: 'OpenCode' },
      ] as never[], 'opencode-acp')
      expect(spawnMock).toHaveBeenCalledWith('cmd.exe', ['/c', 'where', 'opencode.cmd'], {
        stdio: 'ignore', windowsHide: true,
      })
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })
})

describe('discoverAcpProviders codex/pi adapters', () => {
  beforeEach(() => {
    resetAcpDiscoveryCacheForTests()
    spawnMock.mockImplementation(spawnErrorChild)
  })

  it('reports codex-acp and pi-acp as missing with adapter install hints when binaries are absent', async () => {
    const providers = [
      { id: 'codex-acp', label: 'Codex ACP', description: 'Codex ACP' },
      { id: 'pi-acp', label: 'Pi ACP', description: 'Pi ACP' },
    ] as never[]

    const result = await discoverAcpProviders(providers, 'codex-acp')
    const byId = new Map(result.map((item) => [item.id, item]))

    expect(byId.get('codex-acp')).toMatchObject({
      id: 'codex-acp',
      command: 'codex-acp',
      installed: false,
      handshakeOk: false,
      status: 'missing',
    })
    expect(byId.get('codex-acp')?.compatibility).toContain('@agentclientprotocol/codex-acp')
    expect(byId.get('pi-acp')).toMatchObject({
      id: 'pi-acp',
      command: 'pi-acp',
      installed: false,
      handshakeOk: false,
      status: 'missing',
    })
    expect(byId.get('pi-acp')?.compatibility).toContain('pi-acp')
  })
})
