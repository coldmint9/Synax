// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalConfig, ProviderDef } from '../../../lib/contracts/config'

const mocks = vi.hoisted(() => ({
  discoverAcp: vi.fn(),
  discoverAiModels: vi.fn(),
  validateAiApi: vi.fn(),
  reload: vi.fn(),
  updateGlobalConfig: vi.fn(),
  state: {
    globalConfig: null as GlobalConfig | null,
    providers: [] as ProviderDef[],
  },
}))

const acpProviders: ProviderDef[] = [
  {
    id: 'opencode-acp',
    label: 'OpenCode ACP',
    status: 'live',
    kind: 'acp',
    caps: { canFollowUp: true, canCancel: true },
    models: [{ id: 'opencode-default', label: 'OpenCode Default', isDefault: true }],
  },
  {
    id: 'cursor-acp',
    label: 'Cursor ACP',
    status: 'live',
    kind: 'acp',
    caps: { canFollowUp: true, canCancel: true },
    models: [{ id: 'cursor-default', label: 'Cursor Default', isDefault: true }],
  },
]

function createGlobalConfig(extra?: Partial<GlobalConfig>): GlobalConfig {
  const providers: ProviderDef[] = [
    ...acpProviders,
    {
      id: 'openai',
      label: 'OpenAI',
      description: 'OpenAI API',
      status: 'live',
      kind: 'api',
      caps: { canFollowUp: true, canCancel: true },
      models: [{ id: 'gpt-4o-mini', label: 'gpt-4o-mini', isDefault: true }],
    },
    {
      id: 'anthropic',
      label: 'Anthropic',
      description: 'Anthropic Messages API',
      status: 'live',
      kind: 'api',
      caps: { canFollowUp: true, canCancel: true },
      models: [{ id: 'claude-3-5-sonnet-latest', label: 'claude-3-5-sonnet-latest', isDefault: true }],
    },
    ...(extra?.providers?.filter((provider) => !['opencode-acp', 'cursor-acp', 'openai', 'anthropic'].includes(provider.id)) ?? []),
  ]

  const base: GlobalConfig = {
    version: 1,
    providers,
    defaultProviderId: 'opencode-acp',
    defaultApiProviderId: 'openai',
    providerConnections: {
      'opencode-acp': { providerId: 'opencode-acp', baseUrl: 'http://127.0.0.1:3210', extra: { kind: 'acp' } },
      'cursor-acp': { providerId: 'cursor-acp', baseUrl: 'http://127.0.0.1:3210', extra: { kind: 'acp' } },
      openai: {
        providerId: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyMasked: 'sk-o****1234',
        extra: { kind: 'api', apiFormat: 'openai', model: 'gpt-4o-mini' },
      },
      anthropic: {
        providerId: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        extra: { kind: 'api', apiFormat: 'anthropic', model: 'claude-3-5-sonnet-latest' },
      },
      ...(extra?.providerConnections ?? {}),
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
    updatedBy: 'test',
  }

  return {
    ...base,
    ...extra,
    providers,
    providerConnections: {
      ...base.providerConnections,
      ...(extra?.providerConnections ?? {}),
    },
    limits: {
      ...base.limits,
      ...(extra?.limits ?? {}),
    },
    features: {
      ...base.features,
      ...(extra?.features ?? {}),
    },
  }
}

async function renderPage() {
  const { default: GlobalSettingsPage } = await import('./GlobalSettingsPage.tsx')
  return render(
    <MemoryRouter>
      <GlobalSettingsPage />
    </MemoryRouter>,
  )
}

describe('GlobalSettingsPage LLM provider redesign', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(async () => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    mocks.discoverAcp.mockResolvedValue({ selectedProviderId: 'opencode-acp', supported: [] })
    mocks.discoverAiModels.mockResolvedValue({ ok: true, models: ['deepseek-chat'], source: 'api/models' })
    mocks.validateAiApi.mockResolvedValue({ ok: true, message: 'ok' })
    mocks.reload.mockResolvedValue(undefined)
    mocks.updateGlobalConfig.mockResolvedValue(undefined)
    mocks.state.globalConfig = createGlobalConfig()
    mocks.state.providers = mocks.state.globalConfig.providers

    const configModule = await import('../../../lib/api/config.ts')
    vi.spyOn(configModule.configApi, 'discoverAcp').mockImplementation(mocks.discoverAcp)
    vi.spyOn(configModule.configApi, 'discoverAiModels').mockImplementation(mocks.discoverAiModels)
    vi.spyOn(configModule.configApi, 'validateAiApi').mockImplementation(mocks.validateAiApi)

    const useConfigModule = await import('./useConfig.ts')
    vi.spyOn(useConfigModule, 'useConfig').mockImplementation(() => ({
      globalConfig: mocks.state.globalConfig,
      projectConfig: null,
      effectiveConfig: null,
      providers: mocks.state.providers,
      llmProviders: mocks.state.providers,
      loading: false,
      reload: mocks.reload,
      updateGlobalConfig: mocks.updateGlobalConfig,
      updateProjectConfig: vi.fn(),
      resetProjectConfig: vi.fn(),
    }))
  })

  it('opens the add modal and enters a preset API key configuration view', async () => {
    const user = userEvent.setup()
    await renderPage()

    await user.click(screen.getByRole('button', { name: /添加/ }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByLabelText('OpenAI logo')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Anthropic logo')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('DeepSeek logo')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('OpenRouter logo')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('xAI logo')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /DeepSeek/ }))
    expect(screen.getByText('custom-api:deepseek')).toBeInTheDocument()
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.deepseek.com')
    expect(screen.getByLabelText('Base URL')).toBeDisabled()
  })

  it('probes configured LLM providers when the settings page loads', async () => {
    mocks.state.globalConfig = createGlobalConfig({
      providerConnections: {
        openai: {
          providerId: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKeyMasked: 'sk-o****1234',
          extra: { kind: 'api', apiFormat: 'openai', model: 'gpt-4o-mini' },
        },
        anthropic: {
          providerId: 'anthropic',
          baseUrl: 'https://api.anthropic.com/v1',
          apiKeyMasked: 'sk-a****9999',
          extra: { kind: 'api', apiFormat: 'anthropic', model: 'claude-3-5-sonnet-latest' },
        },
      },
    })
    mocks.state.providers = mocks.state.globalConfig.providers

    await renderPage()

    await waitFor(() => expect(mocks.validateAiApi).toHaveBeenCalledTimes(2))
    expect(mocks.validateAiApi).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'openai',
        format: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
      }),
    )
    expect(mocks.validateAiApi).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'anthropic',
        format: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'claude-3-5-sonnet-latest',
      }),
    )

    const openaiCard = screen.getByRole('heading', { name: 'OpenAI' }).closest('article')
    const anthropicCard = screen.getByRole('heading', { name: 'Anthropic' }).closest('article')
    expect(openaiCard).not.toBeNull()
    expect(anthropicCard).not.toBeNull()
    expect(within(openaiCard!).getByText('在线')).toBeInTheDocument()
    expect(within(anthropicCard!).getByText('在线')).toBeInTheDocument()
  })

  it('opens the custom configuration path with editable Base URL and saves through global config', async () => {
    const user = userEvent.setup()
    await renderPage()

    await user.click(screen.getByRole('button', { name: /添加/ }))
    await user.click(screen.getByRole('button', { name: /^自定义/ }))

    await user.clear(screen.getByLabelText('名称'))
    await user.type(screen.getByLabelText('名称'), 'Local Gateway')
    await user.clear(screen.getByLabelText('Base URL'))
    await user.type(screen.getByLabelText('Base URL'), 'https://llm.internal/v1')
    await user.type(screen.getByLabelText('API Key'), 'sk-local')
    await user.clear(screen.getByLabelText('模型'))
    await user.type(screen.getByLabelText('模型'), 'local-model')
    await user.click(screen.getByRole('button', { name: /保存 Provider/ }))

    const payload = mocks.updateGlobalConfig.mock.calls[0][0]
    const customProvider = payload.providers.find((provider: ProviderDef) => provider.label === 'Local Gateway')
    expect(customProvider).toEqual(expect.objectContaining({ kind: 'api' }))
    expect(payload.providerConnections[customProvider.id]).toEqual(
      expect.objectContaining({
        baseUrl: 'https://llm.internal/v1',
        apiKey: 'sk-local',
      }),
    )
  })

  it('renders multiple discovered models in a selectable dropdown', async () => {
    const user = userEvent.setup()
    mocks.discoverAiModels.mockResolvedValueOnce({
      ok: true,
      models: ['gpt-4o-mini', 'gpt-4.1', 'gpt-4o'],
      source: 'openai/models',
    })
    await renderPage()

    await user.click(screen.getByRole('button', { name: /添加/ }))
    await user.click(screen.getByRole('button', { name: /DeepSeek/ }))

    const apiKeyInput = await screen.findByLabelText('API Key')
    await user.type(apiKeyInput, 'sk-openai')
    await user.click(screen.getByRole('button', { name: /获取模型/ }))

    const modelSelect = screen.getByLabelText('已获取模型')
    expect(within(modelSelect).getByRole('option', { name: 'gpt-4o-mini' })).toBeInTheDocument()
    expect(within(modelSelect).getByRole('option', { name: 'gpt-4.1' })).toBeInTheDocument()
    expect(within(modelSelect).getByRole('option', { name: 'gpt-4o' })).toBeInTheDocument()

    await user.selectOptions(modelSelect, 'gpt-4.1')
    expect(screen.getByLabelText('模型')).toHaveValue('gpt-4.1')
  })

  it('removes a configured compatible provider card', async () => {
    const user = userEvent.setup()
    const deepseekProvider: ProviderDef = {
      id: 'custom-api:deepseek',
      label: 'DeepSeek',
      description: 'DeepSeek OpenAI-compatible API',
      status: 'live',
      kind: 'api',
      caps: { canFollowUp: true, canCancel: true },
      models: [{ id: 'deepseek-chat', label: 'deepseek-chat', isDefault: true }],
    }
    mocks.state.globalConfig = createGlobalConfig({
      providers: [...acpProviders, deepseekProvider],
      providerConnections: {
        'custom-api:deepseek': {
          providerId: 'custom-api:deepseek',
          baseUrl: 'https://api.deepseek.com',
          apiKeyMasked: 'sk-d****5678',
          extra: { kind: 'api', apiFormat: 'openai', model: 'deepseek-chat' },
        },
      },
    })
    mocks.state.providers = mocks.state.globalConfig.providers
    await renderPage()

    const deepseekCard = screen.getByText('DeepSeek').closest('article')
    expect(deepseekCard).not.toBeNull()

    await user.click(within(deepseekCard!).getByRole('button', { name: /删除/ }))
    expect(mocks.updateGlobalConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.not.arrayContaining([
          expect.objectContaining({ id: 'custom-api:deepseek' }),
        ]),
      }),
    )
  })

  it('deletes the default provider by switching to another configured provider first', async () => {
    const user = userEvent.setup()
    mocks.state.globalConfig = createGlobalConfig({
      providerConnections: {
        anthropic: {
          providerId: 'anthropic',
          baseUrl: 'https://api.anthropic.com/v1',
          apiKeyMasked: 'sk-a****9999',
          extra: { kind: 'api', apiFormat: 'anthropic', model: 'claude-3-5-sonnet-latest' },
        },
      },
    })
    mocks.state.providers = mocks.state.globalConfig.providers
    await renderPage()

    const openaiCard = screen.getByRole('heading', { name: 'OpenAI' }).closest('article')
    expect(openaiCard).not.toBeNull()

    await user.click(within(openaiCard!).getByRole('button', { name: /删除/ }))

    expect(mocks.updateGlobalConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultApiProviderId: 'anthropic',
        providerConnections: expect.objectContaining({
          openai: expect.objectContaining({ apiKey: '' }),
        }),
      }),
    )
  })

  it('sets a configured compatible provider as default', async () => {
    const user = userEvent.setup()
    const deepseekProvider: ProviderDef = {
      id: 'custom-api:deepseek',
      label: 'DeepSeek',
      description: 'DeepSeek OpenAI-compatible API',
      status: 'live',
      kind: 'api',
      caps: { canFollowUp: true, canCancel: true },
      models: [{ id: 'deepseek-chat', label: 'deepseek-chat', isDefault: true }],
    }
    mocks.state.globalConfig = createGlobalConfig({
      providers: [...acpProviders, deepseekProvider],
      providerConnections: {
        'custom-api:deepseek': {
          providerId: 'custom-api:deepseek',
          baseUrl: 'https://api.deepseek.com',
          apiKeyMasked: 'sk-d****5678',
          extra: { kind: 'api', apiFormat: 'openai', model: 'deepseek-chat' },
        },
      },
    })
    mocks.state.providers = mocks.state.globalConfig.providers
    await renderPage()

    const deepseekCard = screen.getByText('DeepSeek').closest('article')
    expect(deepseekCard).not.toBeNull()

    await user.click(within(deepseekCard!).getByRole('button', { name: /设为默认/ }))
    expect(mocks.updateGlobalConfig).toHaveBeenCalledWith({ defaultApiProviderId: 'custom-api:deepseek' })
  })
})
