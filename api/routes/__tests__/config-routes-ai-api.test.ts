import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalEnv = {
  CONFIG_ENCRYPTION_KEY: process.env.CONFIG_ENCRYPTION_KEY,
  DATA_ROOT: process.env.DATA_ROOT,
}

let tempDir = ''

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Synax-config-routes-'))
  process.env.DATA_ROOT = tempDir
  process.env.CONFIG_ENCRYPTION_KEY = 'route-test-secret'
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})

afterEach(async () => {
  const dbModule = await import('../../db/index.js')
  dbModule.closeDb()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
  process.env.DATA_ROOT = originalEnv.DATA_ROOT
  process.env.CONFIG_ENCRYPTION_KEY = originalEnv.CONFIG_ENCRYPTION_KEY
})

describe('config routes ai api provider auth', () => {
  it('discovers models using the stored provider API key when the request omits apiKey', async () => {
    const fetchMock = vi.fn(async () => (
      new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ))
    vi.stubGlobal('fetch', fetchMock)

    const { updateGlobalConfig } = await import('../../lib/config/config-store.js')
    updateGlobalConfig(
      {
        defaultApiProviderId: 'openai',
        providerConnections: {
          openai: {
            providerId: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'sk-stored-openai',
            extra: {
              kind: 'api',
              apiFormat: 'openai',
              model: 'gpt-4o-mini',
            },
          },
        },
      },
      'route-test',
    )

    const { configRoutes } = await import('../config.js')
    const res = await configRoutes.request('http://localhost/ai-api/models/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId: 'openai',
        format: 'openai',
        baseUrl: 'https://api.openai.com/v1',
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.models).toEqual(['gpt-4o-mini'])
    expect(body.source).toBe('openai/models')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer sk-stored-openai',
        }),
      }),
    )
  })

  it('discovers Anthropic models from the real models endpoint shape', async () => {
    const fetchMock = vi.fn(async () => (
      new Response(JSON.stringify({ data: [{ id: 'claude-opus-4-7' }, { id: 'claude-sonnet-4-6' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ))
    vi.stubGlobal('fetch', fetchMock)

    const { configRoutes } = await import('../config.js')
    const res = await configRoutes.request('http://localhost/ai-api/models/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant-test',
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({
      ok: true,
      models: ['claude-opus-4-7', 'claude-sonnet-4-6'],
      source: 'anthropic/models',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
          'x-api-key': 'sk-ant-test',
          'anthropic-version': '2023-06-01',
        }),
      }),
    )
  })

  it('rejects model discovery before making a fake unauthenticated request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { configRoutes } = await import('../config.js')
    const res = await configRoutes.request('http://localhost/ai-api/models/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format: 'openai',
        baseUrl: 'https://api.openai.com/v1',
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body).toEqual({
      ok: false,
      models: [],
      source: 'openai/models',
      error: '请先配置 API Key',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps an empty real model response empty instead of falling back to preset models', async () => {
    const fetchMock = vi.fn(async () => (
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ))
    vi.stubGlobal('fetch', fetchMock)

    const { configRoutes } = await import('../config.js')
    const res = await configRoutes.request('http://localhost/ai-api/models/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({
      ok: true,
      models: [],
      source: 'openai/models',
      error: '模型接口未返回可识别的模型 ID',
    })
  })

  it('validates an API connection using the stored provider API key', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'chatcmpl_test' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { updateGlobalConfig } = await import('../../lib/config/config-store.js')
    updateGlobalConfig(
      {
        defaultApiProviderId: 'openai',
        providerConnections: {
          openai: {
            providerId: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'sk-stored-openai',
            extra: {
              kind: 'api',
              apiFormat: 'openai',
              model: 'gpt-4o-mini',
            },
          },
        },
      },
      'route-test',
    )

    const { configRoutes } = await import('../config.js')
    const res = await configRoutes.request('http://localhost/ai-api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId: 'openai',
        format: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-stored-openai',
        }),
      }),
    )
  })

  it('saves and removes compatible preset providers through the global config route', async () => {
    const { getGlobalConfig } = await import('../../lib/config/config-store.js')
    const { configRoutes } = await import('../config.js')
    const current = getGlobalConfig()
    const deepseekProvider = {
      id: 'custom-api:deepseek',
      label: 'DeepSeek',
      description: 'DeepSeek OpenAI-compatible API',
      status: 'live' as const,
      kind: 'api' as const,
      caps: { canFollowUp: true, canCancel: true },
      models: [{ id: 'deepseek-chat', label: 'deepseek-chat', isDefault: true }],
    }

    const saveRes = await configRoutes.request('http://localhost/global', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providers: [...current.providers, deepseekProvider],
        defaultApiProviderId: 'custom-api:deepseek',
        providerConnections: {
          'custom-api:deepseek': {
            providerId: 'custom-api:deepseek',
            baseUrl: 'https://api.deepseek.com',
            apiKey: 'sk-deepseek',
            extra: {
              kind: 'api',
              apiFormat: 'openai',
              model: 'deepseek-chat',
            },
          },
        },
      }),
    })
    const saveBody = await saveRes.json()

    expect(saveRes.status).toBe(200)
    expect(saveBody.config.defaultApiProviderId).toBe('custom-api:deepseek')
    expect(saveBody.config.providers).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'custom-api:deepseek' })]),
    )

    const removeRes = await configRoutes.request('http://localhost/global', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providers: saveBody.config.providers.filter((provider: { id: string }) => provider.id !== 'custom-api:deepseek'),
        defaultApiProviderId: 'openai',
        providerConnections: {
          openai: {
            providerId: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'sk-openai',
            extra: {
              kind: 'api',
              apiFormat: 'openai',
              model: 'gpt-4o-mini',
            },
          },
        },
      }),
    })
    const removeBody = await removeRes.json()

    expect(removeRes.status).toBe(200)
    expect(removeBody.config.defaultApiProviderId).toBe('openai')
    expect(removeBody.config.providers.some((provider: { id: string }) => provider.id === 'custom-api:deepseek')).toBe(false)
  })

  it('does not require the current default API provider key when only adding another provider', async () => {
    const { getGlobalConfig } = await import('../../lib/config/config-store.js')
    const { configRoutes } = await import('../config.js')
    const current = getGlobalConfig()
    const deepseekProvider = {
      id: 'custom-api:deepseek',
      label: 'DeepSeek',
      description: 'DeepSeek OpenAI-compatible API',
      status: 'live' as const,
      kind: 'api' as const,
      caps: { canFollowUp: true, canCancel: true },
      models: [{ id: 'deepseek-chat', label: 'deepseek-chat', isDefault: true }],
    }

    const res = await configRoutes.request('http://localhost/global', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providers: [...current.providers, deepseekProvider],
        providerConnections: {
          'custom-api:deepseek': {
            providerId: 'custom-api:deepseek',
            baseUrl: 'https://api.deepseek.com',
            apiKey: 'sk-deepseek',
            extra: {
              kind: 'api',
              apiFormat: 'openai',
              model: 'deepseek-chat',
            },
          },
        },
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.config.defaultApiProviderId).toBe('openai')
    expect(body.config.providerConnections.openai.apiKeyMasked).toBeUndefined()
    expect(body.config.providers).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'custom-api:deepseek' })]),
    )
  })
})
