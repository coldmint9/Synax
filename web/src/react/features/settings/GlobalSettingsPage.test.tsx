import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalConfig, ProviderDef } from '../../../lib/contracts/config'
import { useState, type ReactNode } from 'react'

vi.mock('@heroui/react', () => {
  const Passthrough = ({ children, className }: any) => <div className={className}>{children}</div>
  const TabsComp = ({ children }: any) => <div>{children}</div>
  TabsComp.ListContainer = Passthrough
  TabsComp.List = ({ children }: any) => <div role="tablist">{children}</div>
  TabsComp.Tab = ({ children, id }: any) => <button role="tab" data-id={id}>{children}</button>
  TabsComp.Indicator = () => null
  TabsComp.Panel = ({ children }: any) => <div role="tabpanel">{children}</div>
  const CardComp = ({ children, className }: any) => <div className={className}>{children}</div>
  CardComp.Header = Passthrough
  CardComp.Content = Passthrough
  CardComp.Footer = Passthrough
  CardComp.Title = Passthrough
  CardComp.Description = Passthrough
  const { useState: useStateHook } = require('react')
  const DropdownComp = ({ children }: any) => {
    const [open, setOpen] = useStateHook(false)
    const childArray = Array.isArray(children) ? children : [children]
    const trigger = childArray[0]
    const popover = childArray[1]
    return <div>
      <div onClick={() => setOpen(!open)}>{trigger}</div>
      {open && popover}
    </div>
  }
  DropdownComp.Popover = ({ children }: any) => <div>{children}</div>
  DropdownComp.Menu = ({ children, onAction, 'aria-label': ariaLabel }: any) => {
    return <div aria-label={ariaLabel} onClick={(e: any) => {
      const key = (e.target as HTMLElement).closest('[data-key]')?.getAttribute('data-key')
      if (key && onAction) onAction(key)
    }}>{children}</div>
  }
  DropdownComp.Item = ({ children, id, textValue }: any) => {
    const label = typeof children === 'string' ? children : textValue
    return <button data-key={id}>{label}</button>
  }
  const SelectComp = ({ children, 'aria-label': ariaLabel }: any) => <div aria-label={ariaLabel}>{children}</div>
  SelectComp.Trigger = Passthrough
  SelectComp.Value = () => null
  SelectComp.Indicator = () => null
  SelectComp.Popover = Passthrough
  const ListBoxComp = ({ children }: any) => <div role="listbox">{children}</div>
  ListBoxComp.Item = ({ children, id, textValue }: any) => <div role="option" aria-label={textValue}>{children}</div>
  ListBoxComp.ItemIndicator = () => null
  const { createContext, useContext } = require('react')
  const fieldContext = createContext({ value: '', onChange: (_value: string) => {} })
  const InputGroupComp = Object.assign(Passthrough, {
    Input: (props: any) => {
      const field = useContext(fieldContext)
      return <input {...props} value={field.value ?? ''} onChange={event => field.onChange?.(event.target.value)} />
    }, Prefix: Passthrough, Suffix: Passthrough,
  })
  const dialog = (role: string) => ({
    Backdrop: ({ children, isOpen = true }: any) => isOpen ? <>{children}</> : null,
    Container: Passthrough, Dialog: ({ children }: any) => <div role={role}>{children}</div>,
    Header: Passthrough, Body: Passthrough, Footer: Passthrough,
    Heading: ({ children }: any) => <h2>{children}</h2>, Icon: () => null, CloseTrigger: () => null,
  })
  return {
    Modal: dialog('dialog'), AlertDialog: dialog('alertdialog'),
    TextField: ({ children, value, onChange }: any) => <fieldContext.Provider value={{ value, onChange }}><div>{children}</div></fieldContext.Provider>,
    InputGroup: InputGroupComp, FieldError: Passthrough, Description: Passthrough,
    Button: ({ children, onPress, startContent, isLoading, isPending, isDisabled, isIconOnly, ...props }: any) => (
      <button onClick={onPress} disabled={isDisabled || isLoading || isPending} {...props}>{startContent}{typeof children === 'function' ? children({ isPending: Boolean(isPending) }) : children}</button>
    ),
    Card: CardComp,
    Chip: ({ children }: any) => <span>{children}</span>,
    Checkbox: Object.assign(
      ({ children, isSelected, onChange, isDisabled }: any) => (
        <label><input type="checkbox" checked={isSelected} onChange={(e: any) => onChange?.(e.target.checked)} disabled={isDisabled} />{children}</label>
      ),
      {
        Control: Passthrough,
        Indicator: () => null,
        Content: Passthrough,
      },
    ),
    Dropdown: DropdownComp,
    Input: ({ value, onValueChange, placeholder, label, endContent, type, isDisabled, description, ...props }: any) => (
      <div>
        {label && <label>{label}</label>}
        <input value={value ?? ''} onChange={(e: any) => onValueChange?.(e.target.value)} placeholder={placeholder} type={type} disabled={isDisabled} />
        {endContent}
        {description && <span>{description}</span>}
      </div>
    ),
    Label: ({ children }: any) => <span>{children}</span>,
    ListBox: ListBoxComp,
    NumberField: Object.assign(
      ({ children, value, onChange, label }: any) => (
        <div>{label && <label>{label}</label>}{children}<input value={value ?? ''} onChange={(e: any) => onChange?.(Number(e.target.value) || 0)} /></div>
      ),
      {
        Group: Passthrough,
        Input: () => <span />,
      },
    ),
    ScrollShadow: Passthrough,
    Select: SelectComp,
    Spinner: ({ size }: any) => <span data-testid="spinner" data-size={size} />,
    Surface: Passthrough,
    Switch: Object.assign(
      ({ isSelected, onChange, children }: any) => (
        <label><input type="checkbox" checked={isSelected} onChange={(e: any) => onChange?.(e.target.checked)} />{children}</label>
      ),
      {
        Control: Passthrough,
        Thumb: () => null,
        Content: Passthrough,
        Icon: () => null,
      },
    ),
    Tabs: TabsComp,
    TextArea: ({ value, onChange, label }: any) => (
      <div>{label && <label>{label}</label>}<textarea value={value} onChange={onChange} /></div>
    ),
    Typography: ({ children }: any) => <span>{children}</span>,
  }
})

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
    ...(extra?.providers?.filter((p) => !['opencode-acp', 'cursor-acp', 'openai', 'anthropic'].includes(p.id)) ?? []),
  ]

  const base: GlobalConfig = {
    version: 1,
    providers,
    defaultProviderId: 'opencode-acp',
    defaultApiProviderId: 'openai',
    enabledAcpProviderIds: ['opencode-acp'],
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
    limits: { maxAgentsPerProject: 10, agentTimeoutMs: 300000 },
    features: { allowProjectConnectionOverride: true },
    updatedAt: '2026-05-13T00:00:00.000Z',
    updatedBy: 'test',
  }

  return { ...base, ...extra, providers, providerConnections: { ...base.providerConnections, ...(extra?.providerConnections ?? {}) }, limits: { ...base.limits, ...(extra?.limits ?? {}) }, features: { ...base.features, ...(extra?.features ?? {}) } }
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
  afterEach(() => { cleanup() })

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

  it('does not expose ACP configuration in settings', async () => {
    await renderPage()
    expect(screen.queryByText('OpenCode ACP')).not.toBeInTheDocument()
    expect(screen.queryByText('Cursor ACP')).not.toBeInTheDocument()
    expect(mocks.discoverAcp).not.toHaveBeenCalled()
  })

  it('opens the add dropdown and enters a preset configuration view', async () => {
    const user = userEvent.setup()
    await renderPage()

    await user.click(screen.getByRole('button', { name: /添加/ }))
    expect(screen.getByRole('button', { name: /^OpenAI$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Anthropic$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^DeepSeek$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^OpenRouter$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^xAI$/ })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^DeepSeek$/ }))
    expect(screen.getByDisplayValue('https://api.deepseek.com')).toBeInTheDocument()
    expect(screen.getByDisplayValue('deepseek-chat')).toBeInTheDocument()
  })

  it('renders configured LLM provider cards with stored keys', async () => {
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

    expect(screen.getByText('OpenAI')).toBeInTheDocument()
    expect(screen.getByText('Anthropic')).toBeInTheDocument()
    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument()
    expect(screen.getByText('claude-3-5-sonnet-latest')).toBeInTheDocument()
  })

  it('opens the custom configuration path and saves through global config', async () => {
    const user = userEvent.setup()
    await renderPage()

    await user.click(screen.getByRole('button', { name: /添加/ }))
    await user.click(screen.getByRole('button', { name: /^自定义/ }))

    const baseUrlInput = screen.getByPlaceholderText('https://api.example.com')
    const modelInput = within(screen.getByRole('dialog')).getByText('模型', { selector: 'span' }).parentElement!.querySelector('input')!

    await user.clear(baseUrlInput)
    await user.type(baseUrlInput, 'https://llm.internal/v1')
    await user.clear(modelInput)
    await user.type(modelInput, 'local-model')

    const apiKeyInput = screen.getByPlaceholderText('输入 API Key')
    await user.type(apiKeyInput, 'sk-local')
    await user.click(screen.getByRole('button', { name: /保存 Provider/ }))

    await waitFor(() => expect(mocks.validateAiApi).toHaveBeenCalled())
    await waitFor(() => expect(mocks.updateGlobalConfig).toHaveBeenCalled())

    const payload = mocks.updateGlobalConfig.mock.calls[0][0]
    const customProvider = payload.providers.find((p: ProviderDef) => p.label.startsWith('Custom'))
    expect(customProvider).toEqual(expect.objectContaining({ kind: 'api' }))
    expect(payload.providerConnections[customProvider.id]).toEqual(
      expect.objectContaining({ baseUrl: 'https://llm.internal/v1', apiKey: 'sk-local' }),
    )
  })

  it('discovers models as candidates and only configures the selected ones', async () => {
    const user = userEvent.setup()
    mocks.discoverAiModels.mockResolvedValueOnce({
      ok: true,
      models: ['gpt-4o-mini', 'gpt-4.1', 'gpt-4o'],
      source: 'openai/models',
    })
    await renderPage()

    await user.click(screen.getByRole('button', { name: /添加/ }))
    await user.click(screen.getByRole('button', { name: /^DeepSeek$/ }))

    const apiKeyInput = screen.getByPlaceholderText('输入 API Key')
    await user.type(apiKeyInput, 'sk-test')
    await user.click(screen.getByRole('button', { name: /发现/ }))

    // 发现的模型只是候选：没有任何一个被自动配置
    const discovered = await screen.findByRole('button', { name: 'gpt-4.1', exact: true })
    expect(discovered).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'gpt-4o-mini', exact: true })).toHaveAttribute('aria-pressed', 'false')

    // 只勾选 gpt-4o，默认模型仍是 deepseek-chat
    await user.click(screen.getByRole('button', { name: 'gpt-4o', exact: true }))
    expect(screen.getByRole('button', { name: 'gpt-4o', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: '完成' }))
    await user.click(screen.getByRole('button', { name: /保存 Provider/ }))

    await waitFor(() => expect(mocks.updateGlobalConfig).toHaveBeenCalled())

    const payload = mocks.updateGlobalConfig.mock.calls[0][0]
    const provider = payload.providers.find((p: ProviderDef) => p.id === 'custom-api:deepseek')
    expect(provider.models.map((m: { id: string }) => m.id)).toEqual(['deepseek-chat', 'gpt-4o'])
    expect(provider.models.find((m: { id: string }) => m.id === 'deepseek-chat')).toEqual(
      expect.objectContaining({ isDefault: true }),
    )
  })

  it('configures the 1M input window per enabled model', async () => {
    const user = userEvent.setup()
    mocks.discoverAiModels.mockResolvedValueOnce({
      ok: true,
      models: ['deepseek-chat', 'deepseek-reasoner'],
      source: 'api/models',
    })
    await renderPage()

    await user.click(screen.getByRole('button', { name: /添加/ }))
    await user.click(screen.getByRole('button', { name: /^DeepSeek$/ }))

    await user.type(screen.getByPlaceholderText('输入 API Key'), 'sk-test')
    await user.click(screen.getByRole('button', { name: /发现/ }))
    await user.click(await screen.findByRole('button', { name: 'deepseek-reasoner', exact: true }))
    await user.click(screen.getByRole('button', { name: '完成' }))

    const chatWindow = screen.getByRole('checkbox', { name: 'deepseek-chat 输入上下文窗口支持 1M' })
    const reasonerWindow = screen.getByRole('checkbox', { name: 'deepseek-reasoner 输入上下文窗口支持 1M' })
    expect(chatWindow).not.toBeChecked()

    // 逐个模型生效：只给 deepseek-reasoner 打开 1M
    await user.click(reasonerWindow)
    expect(reasonerWindow).toBeChecked()
    expect(chatWindow).not.toBeChecked()

    await user.click(screen.getByRole('button', { name: /保存 Provider/ }))
    await waitFor(() => expect(mocks.updateGlobalConfig).toHaveBeenCalled())

    const payload = mocks.updateGlobalConfig.mock.calls[0][0]
    const provider = payload.providers.find((p: ProviderDef) => p.id === 'custom-api:deepseek')
    expect(provider.models.find((m: { id: string }) => m.id === 'deepseek-reasoner')).toEqual(
      expect.objectContaining({ contextLimit: 1_000_000 }),
    )
    expect(provider.models.find((m: { id: string }) => m.id === 'deepseek-chat')?.contextLimit).toBeUndefined()
  })

  it('removes a configured provider card', async () => {
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

    expect(screen.getByText('DeepSeek')).toBeInTheDocument()
    fireEvent.click(screen.getByText('DeepSeek').closest('button')!)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /删除/ })).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: /删除/ }))
    expect(mocks.updateGlobalConfig).not.toHaveBeenCalled()
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '删除', exact: true }))

    expect(mocks.updateGlobalConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.not.arrayContaining([
          expect.objectContaining({ id: 'custom-api:deepseek' }),
        ]),
      }),
    )
  })

  it('sets a configured provider as default', async () => {
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

    fireEvent.click(screen.getByText('DeepSeek').closest('button')!)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /设为默认/ })).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: /设为默认/ }))

    expect(mocks.updateGlobalConfig).toHaveBeenCalledWith({
      defaultApiProviderId: 'custom-api:deepseek',
    })
  })
})
