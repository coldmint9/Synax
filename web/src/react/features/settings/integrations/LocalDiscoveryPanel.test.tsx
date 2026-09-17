import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDiscoveryPanel } from './LocalDiscoveryPanel'
import {
  localDiscoveryApi,
  type LocalDiscoveryResult,
} from '../../../../lib/api/local-discovery'

vi.mock('../../../../lib/api/local-discovery', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../../lib/api/local-discovery')
  >()),
  localDiscoveryApi: { scan: vi.fn(), importSkill: vi.fn() },
}))
vi.mock('../../../../hooks/useLocale', () => ({
  useLocale: () => ({ locale: 'en' }),
}))
const result: LocalDiscoveryResult = {
  mcp: {
    servers: [
      {
        fingerprint: 'docs',
        server: {
          id: 'docs',
          name: 'Docs MCP',
          command: 'docs-server',
          env: { TOKEN: 'private-token' },
        },
        sources: [
          { client: 'Claude Code', path: '~/.claude.json', scope: 'user' },
        ],
      },
    ],
    unsupported: [],
  },
  skills: [
    {
      id: 'review',
      name: 'Review skill',
      description: 'Review code',
      content: 'Read files first',
      installed: false,
      conflict: false,
      sources: [
        {
          client: 'Codex',
          path: '~/.codex/skills/review/SKILL.md',
          scope: 'user',
        },
      ],
    },
  ],
  locations: [
    {
      client: 'Claude Code',
      path: '~/.claude.json',
      scope: 'user',
      kind: 'mcp',
      status: 'found',
      count: 1,
    },
    {
      client: 'Codex',
      path: '~/.codex/skills',
      scope: 'user',
      kind: 'skill',
      status: 'found',
      count: 1,
    },
  ],
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(localDiscoveryApi.scan).mockResolvedValue(structuredClone(result))
  vi.mocked(localDiscoveryApi.importSkill).mockResolvedValue({
    id: 'project/review',
    name: 'review',
  })
})
describe('LocalDiscoveryPanel', () => {
  it('scans automatically, previews without exposing environment values, and Tab never imports', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<LocalDiscoveryPanel projectId="a" servers={[]} onSave={onSave} />)
    const add = await screen.findByRole('button', { name: 'Add Docs MCP' })
    add.focus()
    await user.tab()
    expect(onSave).not.toHaveBeenCalled()
    await user.click(
      screen.getByRole('button', { name: 'View Docs MCP details' }),
    )
    expect(await screen.findByText('~/.claude.json')).toBeInTheDocument()
    expect(screen.queryByText(/private-token/)).not.toBeInTheDocument()
  })
  it('filters by source and imports full skill packages through the project endpoint', async () => {
    const user = userEvent.setup()
    render(<LocalDiscoveryPanel projectId="a" servers={[]} onSave={vi.fn()} />)
    await screen.findByRole('button', { name: 'Add Review skill' })
    await user.click(screen.getByRole('button', { name: /Codex/ }))
    expect(
      screen.queryByRole('button', { name: 'Add Docs MCP' }),
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add Review skill' }))
    await waitFor(() =>
      expect(localDiscoveryApi.importSkill).toHaveBeenCalledExactlyOnceWith(
        'a',
        'review',
        [],
      ),
    )
    expect(await screen.findByText('Added')).toBeInTheDocument()
  })
  it('keeps successful batch imports while surfacing a later failure', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(undefined)
    vi.mocked(localDiscoveryApi.importSkill).mockRejectedValue(
      new Error('Skill is no longer available'),
    )
    render(<LocalDiscoveryPanel projectId="a" servers={[]} onSave={onSave} />)
    await screen.findByRole('button', { name: 'Add Docs MCP' })
    await user.click(
      screen.getByRole('checkbox', { name: 'Select all available results' }),
    )
    await user.click(screen.getByRole('button', { name: 'Add to project · 2' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Skill is no longer available',
    )
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(screen.getByText('1 selected')).toBeInTheDocument()
  })
  it('recovers from scan errors with an explicit retry', async () => {
    vi.mocked(localDiscoveryApi.scan).mockRejectedValue(
      new Error('Scan unavailable'),
    )
    render(<LocalDiscoveryPanel projectId="a" servers={[]} onSave={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Scan unavailable',
    )
    vi.mocked(localDiscoveryApi.scan).mockResolvedValue(result)
    fireEvent.click(screen.getByRole('button', { name: 'Retry scan' }))
    expect(
      await screen.findByRole('button', { name: 'Add Docs MCP' }),
    ).toBeInTheDocument()
  })
})
