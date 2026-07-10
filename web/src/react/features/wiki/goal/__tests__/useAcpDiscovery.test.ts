import { afterEach, describe, expect, it, vi } from 'vitest'
import { configApi } from '../../../../../lib/api/config'
import { loadAcpDiscovery, prefetchAcpDiscoveryIdle, resetAcpDiscoveryCacheForTests } from '../useAcpDiscovery'

vi.mock('../../../../../lib/api/config', () => ({
  configApi: {
    discoverAcp: vi.fn(async () => ({
      selectedProviderId: 'opencode-acp',
      enabledIds: ['opencode-acp'],
      supported: [{ id: 'opencode-acp', label: 'OpenCode', status: 'missing' }],
    })),
  },
}))

describe('loadAcpDiscovery', () => {
  afterEach(() => {
    resetAcpDiscoveryCacheForTests()
    vi.clearAllMocks()
  })

  it('dedupes concurrent and subsequent requests', async () => {
    const [a, b, c] = await Promise.all([
      loadAcpDiscovery(),
      loadAcpDiscovery(),
      loadAcpDiscovery(),
    ])

    expect(configApi.discoverAcp).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
    expect(b).toEqual(c)

    await loadAcpDiscovery()
    expect(configApi.discoverAcp).toHaveBeenCalledTimes(1)
  })

  it('exports idle prefetch without forcing an immediate request', () => {
    expect(typeof prefetchAcpDiscoveryIdle).toBe('function')
    expect(configApi.discoverAcp).not.toHaveBeenCalled()
  })
})
