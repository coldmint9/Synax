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

import {
  discoverAcpProviders,
  resetAcpDiscoveryCacheForTests,
} from '../discovery.js'

describe('discoverAcpProviders cache', () => {
  beforeEach(() => {
    resetAcpDiscoveryCacheForTests()
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
})
