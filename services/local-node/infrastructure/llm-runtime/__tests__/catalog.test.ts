import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalEnv = {
  DATA_ROOT: process.env.DATA_ROOT,
}

let tempDir = ''

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Synax-llm-catalog-'))
  process.env.DATA_ROOT = tempDir
  vi.restoreAllMocks()
  vi.resetModules()
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.resetModules()
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
  process.env.DATA_ROOT = originalEnv.DATA_ROOT
})

describe('llm catalog cache', () => {
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
