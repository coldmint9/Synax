import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useShellStore } from '../../../../state/shellStore'
import type { AcpDiscoveryItem, GlobalConfig, ProviderDef } from '../../../../lib/contracts/config'
import { GoalModelPicker } from '../GoalModelPicker'

const acpDiscovery: AcpDiscoveryItem[] = [{
  id: 'cursor-acp',
  label: 'Cursor ACP',
  command: 'agent',
  status: 'available',
  installed: true,
  handshakeOk: true,
  selected: false,
  compatibility: '',
  models: [{ id: 'cursor-default', label: 'Cursor Default' }],
}]

vi.mock('../useAcpDiscovery', () => ({
  useAcpDiscovery: () => acpDiscovery,
}))

const globalConfig: GlobalConfig = {
  version: 1,
  providers: [],
  defaultProviderId: 'openai',
  defaultApiProviderId: 'openai',
  enabledAcpProviderIds: ['cursor-acp'],
  providerConnections: {
    openai: { providerId: 'openai', apiKeyMasked: 'sk-***', extra: { model: 'gpt-5' } },
  },
  mcpServers: [],
  limits: { maxAgentsPerProject: 1, agentTimeoutMs: 1 },
  features: { allowProjectConnectionOverride: true },
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'test',
}

const providers: ProviderDef[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    status: 'live',
    kind: 'api',
    caps: { canFollowUp: true, canCancel: true },
    models: [{ id: 'gpt-5', label: 'gpt-5', isDefault: true }],
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

async function openPicker(onSelect = vi.fn()) {
  render(
    <GoalModelPicker
      globalConfig={globalConfig}
      providers={providers}
      providerId="openai"
      modelId="gpt-5"
      onSelect={onSelect}
    />,
  )
  await userEvent.click(screen.getByRole('button', { name: '选择模型' }))
  return onSelect
}

describe('GoalModelPicker', () => {
  beforeEach(() => {
    useShellStore.setState(state => ({ preferences: { ...state.preferences, locale: 'zh' } }))
  })

  it('shows the provider name and model name in the trigger', () => {
    render(
      <GoalModelPicker
        globalConfig={globalConfig}
        providers={providers}
        providerId="openai"
        modelId="gpt-5"
        onSelect={vi.fn()}
      />,
    )

    const trigger = screen.getByRole('button', { name: '选择模型' })
    expect(trigger).toHaveTextContent('OpenAI · gpt-5')
    expect(trigger).toHaveAttribute('title', 'OpenAI · gpt-5')
  })

  it('lists API models and ACP endpoints together in one list separated by a divider', async () => {
    await openPicker()

    const listbox = screen.getByRole('listbox', { name: '选择模型' })
    const options = within(listbox).getAllByRole('option')
    expect(options.map(option => option.textContent)).toEqual([
      'gpt-5openai',
      'Cursor Defaultcursor-acp',
    ])

    // The ACP group follows the API group behind a plain divider, not a second column.
    expect(within(listbox).getAllByRole('separator')).toHaveLength(1)
    expect(screen.queryByText('API 模型')).toBeNull()
    expect(screen.queryByText('ACP 端点')).toBeNull()
  })

  it('marks the current selection and reports the picked option', async () => {
    const onSelect = await openPicker()

    const listbox = screen.getByRole('listbox', { name: '选择模型' })
    const [apiOption, acpOption] = within(listbox).getAllByRole('option')
    expect(apiOption).toHaveAttribute('aria-selected', 'true')
    expect(acpOption).toHaveAttribute('aria-selected', 'false')

    await userEvent.click(acpOption)
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'acp',
      providerId: 'cursor-acp',
      modelId: 'cursor-default',
      label: 'Cursor Default',
    })
  })
})
