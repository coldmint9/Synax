import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../runtime/logger.js', () => ({ logger: { warn: vi.fn() } }))

const originalEnv = {
  DATA_ROOT: process.env.DATA_ROOT,
}
const originalFetch = globalThis.fetch

let tempDir = ''

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Synax-llm-catalog-'))
  process.env.DATA_ROOT = tempDir
  vi.restoreAllMocks()
  vi.resetModules()
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
  process.env.DATA_ROOT = originalEnv.DATA_ROOT
})

describe('llm catalog cache', () => {
  it('lets warm workers adopt the host cache without making remote requests', async () => {
    vi.stubEnv('SYNAX_AGENT_SESSION_CHILD', '1')
    globalThis.fetch = vi.fn(async () => { throw new Error('workers must not refresh remotely') })
    const { getRuntimeCatalog } = await import('../catalog.js')
    expect((await getRuntimeCatalog()).source).toBe('snapshot')
    fs.mkdirSync(path.join(tempDir, 'llm-runtime'), { recursive: true })
    fs.writeFileSync(path.join(tempDir, 'llm-runtime/models-dev-catalog.json'), JSON.stringify({
      savedAt: new Date().toISOString(), catalog: { providers: [{ id: 'host-provider', models: [] }], source: 'remote' },
    }))
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000)
    await vi.waitFor(async () => expect((await getRuntimeCatalog()).providers[0].id).toBe('host-provider'))
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
  it('serves the bundled catalog while one cold refresh is still pending', async () => {
    let complete!: (response: Response) => void
    globalThis.fetch = vi.fn(() => new Promise<Response>(resolve => { complete = resolve }))
    const { getRuntimeCatalog } = await import('../catalog.js')
    const catalogs = await Promise.all(Array.from({ length: 5 }, () => getRuntimeCatalog()))
    expect(catalogs.every(catalog => catalog.source === 'snapshot' && catalog.providers.length > 0)).toBe(true)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    const refreshed = getRuntimeCatalog(true)
    complete({ ok: true, json: async () => ({}) } as Response)
    expect((await refreshed).source).toBe('remote')
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect((await getRuntimeCatalog()).source).toBe('remote')
  })

  it('keeps a stale disk catalog usable while refreshing and coalesces failures', async () => {
    fs.mkdirSync(path.join(tempDir, 'llm-runtime'))
    fs.writeFileSync(path.join(tempDir, 'llm-runtime/models-dev-catalog.json'), JSON.stringify({
      savedAt: '2000-01-01T00:00:00Z', catalog: { providers: [{ id: 'cached-provider', models: [] }], source: 'remote' },
    }))
    let fail!: (error: Error) => void
    globalThis.fetch = vi.fn(() => new Promise<Response>((_resolve, reject) => { fail = reject }))
    const { getRuntimeCatalog } = await import('../catalog.js')
    expect((await getRuntimeCatalog()).providers[0].id).toBe('cached-provider')
    const refresh = getRuntimeCatalog(true)
    fail(new Error('offline'))
    expect((await refresh).source).toBe('cache')
    await getRuntimeCatalog()
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('persists remote catalog and marks disk reloads as cache', async () => {
    const remotePayload = {
      openai: {
        id: 'openai',
        name: 'OpenAI',
        npm: '@ai-sdk/openai',
        api: 'https://api.openai.com/v1',
        env: ['OPENAI_API_KEY'],
        models: {
          'gpt-4o-mini': {
            id: 'gpt-4o-mini',
            name: 'GPT-4o Mini',
          },
        },
      },
    }

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => remotePayload,
    }) as unknown as Response) as unknown as typeof fetch

    const firstModule = await import('../catalog.js')
    const first = await firstModule.getRuntimeCatalog(true)
    expect(first.source).toBe('remote')
    expect(first.providers[0]?.id).toBe('openai')

    vi.resetModules()
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

    const secondModule = await import('../catalog.js')
    const second = await secondModule.getRuntimeCatalog()
    expect(second.source).toBe('cache')
    expect(second.providers[0]?.id).toBe('openai')
  })

  it('falls back to bundled snapshot when remote and cache are unavailable', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch

    const { getRuntimeCatalog } = await import('../catalog.js')
    const catalog = await getRuntimeCatalog(true)

    expect(catalog.source).toBe('snapshot')
    expect(catalog.providers.length).toBeGreaterThan(0)
  })
})
