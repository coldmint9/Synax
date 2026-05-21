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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-config-store-'))
  process.env.DATA_ROOT = tempDir
  process.env.CONFIG_ENCRYPTION_KEY = 'unit-test-secret'
  vi.restoreAllMocks()
  vi.resetModules()
})

afterEach(async () => {
  const dbModule = await import('../../../db/index.js')
  dbModule.closeDb()
  vi.restoreAllMocks()
  vi.resetModules()
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
  process.env.DATA_ROOT = originalEnv.DATA_ROOT
  process.env.CONFIG_ENCRYPTION_KEY = originalEnv.CONFIG_ENCRYPTION_KEY
})

describe('config-store migration and overrides', () => {
  it('migrates legacy API provider fields and masks secrets in display config', async () => {
    const dbModule = await import('../../../db/index.js')
    const { getGlobalConfig } = await import('../config-store.js')

    const sqlite = dbModule.getRawSqlite()
    const legacyConfig = {
      version: 1,
      providers: [],
      defaultProviderId: 'opencode-acp',
      defaultApiProviderId: 'anthropic',
      providerConnections: {
        anthropic: {
          providerId: 'anthropic',
          baseUrl: 'https://api.anthropic.com/v1',
          apiKey: 'legacy-anthropic-key',
          extra: {
            model: 'claude-3-5-sonnet-latest',
          },
        },
      },
      limits: {
        maxAgentsPerProject: 10,
        maxSessionsPerUser: 5,
        agentTimeoutMs: 300000,
      },
      features: {
        allowProjectConnectionOverride: true,
        allowMultiProvider: false,
      },
      updatedAt: '2026-05-13T00:00:00.000Z',
      updatedBy: 'legacy',
    }

    sqlite.prepare(
      `INSERT INTO global_config (id, version, config_json, updated_at, updated_by)
       VALUES (1, ?, ?, ?, ?)`,
    ).run(1, JSON.stringify(legacyConfig), legacyConfig.updatedAt, legacyConfig.updatedBy)

    const config = getGlobalConfig()
    expect(config.defaultApiProviderId).toBe('anthropic')
    expect(config.providers.some((provider) => provider.id === 'anthropic')).toBe(true)
    expect(config.providers.some((provider) => provider.id === 'openai')).toBe(true)

    const anthropicConnection = config.providerConnections.anthropic
    expect(anthropicConnection.baseUrl).toBe('https://api.anthropic.com/v1')
    expect(anthropicConnection.apiKey).toBeUndefined()
    expect(typeof anthropicConnection.apiKeyMasked).toBe('string')
    expect(anthropicConnection.apiKeyMasked).not.toContain('legacy-anthropic-key')
  })

  it('keeps secrets encrypted at rest and merges project overrides over global config', async () => {
    const {
      getEffectiveConfig,
      getGlobalConfig,
      getProjectConfig,
      updateGlobalConfig,
      upsertProjectConfig,
    } = await import('../config-store.js')

    updateGlobalConfig(
      {
        defaultApiProviderId: 'openai',
        providerConnections: {
          openai: {
            providerId: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'sk-global-12345678',
            extra: {
              kind: 'api',
              apiFormat: 'openai',
              model: 'gpt-4o-mini',
            },
          },
        },
      },
      'tester',
    )

    upsertProjectConfig(
      'project-alpha',
      {
        providerId: 'openai',
        modelId: 'gpt-4o-mini',
        providerConnection: {
          providerId: 'openai',
          baseUrl: 'https://override.internal/v1',
        },
      },
      'tester',
    )

    const globalDisplay = getGlobalConfig()
    const projectDisplay = getProjectConfig('project-alpha')
    const effective = getEffectiveConfig('project-alpha')

    expect(globalDisplay.providerConnections.openai.apiKey).toBeUndefined()
    expect(typeof globalDisplay.providerConnections.openai.apiKeyMasked).toBe('string')
    expect(projectDisplay?.providerConnection?.apiKey).toBeUndefined()
    expect(effective.providerId).toBe('openai')
    expect(effective.modelId).toBe('gpt-4o-mini')
    expect(effective.connection.baseUrl).toBe('https://override.internal/v1')
    expect(effective.connection.apiKey).toBe('sk-global-12345678')

    const globalConfigPath = path.join(tempDir, 'config', 'global-config.json')
    const templateConfigPath = path.join(tempDir, 'config', 'template-config.json')
    const rawGlobal = fs.readFileSync(globalConfigPath, 'utf8')
    const rawTemplate = fs.readFileSync(templateConfigPath, 'utf8')
    expect(rawGlobal).not.toContain('sk-global-12345678')
    expect(rawTemplate).toContain('enc:v1:')
  })
})
