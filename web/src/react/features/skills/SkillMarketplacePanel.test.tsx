import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillMarketplacePanel } from './SkillMarketplacePanel'
import {
  skillsApi,
  skillSourcesApi,
  type SkillListResponse,
  type SkillSummary,
} from '../../../lib/api/skills'

vi.mock('../../../hooks/useLocale', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}))
vi.mock('../../../lib/api/skills', () => ({
  MARKET_PAGE_SIZE: 24,
  skillsApi: {
    list: vi.fn(),
    install: vi.fn(),
    uninstall: vi.fn(),
    setEnabled: vi.fn(),
  },
  skillSourcesApi: { list: vi.fn() },
}))
// The source editor isn't part of list/search lifecycle tests.
vi.mock('./SkillAddSourceModal', () => ({
  SkillAddSourceModal: () => null,
  EMPTY_SOURCE_FORM: {},
}))
const skill: SkillSummary = {
  id: 'remote/test',
  name: 'test',
  label: 'Test skill',
  description: 'Example',
  sourceId: 'remote',
  sourceKind: 'remote',
  version: '',
  status: 'available',
  appliesTo: [],
  requiredCapabilities: [],
  permissionHints: [],
}
const result = (
  items = [skill],
  extra: Partial<SkillListResponse> = {},
): SkillListResponse => ({
  items,
  total: items.length,
  totalExact: true,
  hasMore: false,
  ...extra,
})
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(skillsApi.list).mockResolvedValue(result())
  vi.mocked(skillSourcesApi.list).mockResolvedValue({
    items: [
      {
        id: 'remote',
        label: 'Remote catalog',
        type: 'skills-sh',
        enabled: true,
        readOnly: true,
        priority: 60,
        config: {},
        lastSyncAt: null,
        lastSyncError: null,
        createdAt: '',
        updatedAt: '',
      },
    ],
  })
})

describe('SkillMarketplacePanel', () => {
  it('searches the backend, resets pagination, combines source filters and clears search', async () => {
    vi.mocked(skillsApi.list).mockResolvedValue(
      result([skill], { total: 50, hasMore: true }),
    )
    const user = userEvent.setup()
    render(<SkillMarketplacePanel projectId="project-a" />)
    await screen.findByText('Test skill')
    await user.click(
      screen.getByRole('button', { name: 'skillMarketNextPage' }),
    )
    await waitFor(() =>
      expect(skillsApi.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ offset: 24 }),
      ),
    )
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: '  react  ' },
    })
    await waitFor(() =>
      expect(skillsApi.list).toHaveBeenLastCalledWith(
        expect.objectContaining({
          q: 'react',
          offset: 0,
          includeDisabled: true,
        }),
      ),
    )
    await user.click(screen.getByRole('button', { name: /Remote catalog/ }))
    await waitFor(() =>
      expect(skillsApi.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ sourceId: 'remote', q: 'react', offset: 0 }),
      ),
    )
    await user.click(screen.getByRole('button', { name: 'skillSearchClear' }))
    await waitFor(() =>
      expect(skillsApi.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: undefined, offset: 0 }),
      ),
    )
  })

  it('does not let older searches overwrite newer results', async () => {
    const old = deferred<SkillListResponse>()
    vi.mocked(skillsApi.list).mockImplementation(async (query) =>
      query?.q === 'old'
        ? old.promise
        : result([
            {
              ...skill,
              label: query?.q === 'new' ? 'New result' : 'Initial result',
            },
          ]),
    )
    render(<SkillMarketplacePanel />)
    await screen.findByText('Initial result')
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'old' },
    })
    await waitFor(() =>
      expect(skillsApi.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: 'old' }),
      ),
    )
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'new' },
    })
    await screen.findByText('New result')
    await act(async () =>
      old.resolve(result([{ ...skill, label: 'Old result' }])),
    )
    expect(screen.getByText('New result')).toBeInTheDocument()
    expect(screen.queryByText('Old result')).not.toBeInTheDocument()
  })

  it('ignores an old response even while the new keyword is still debouncing', async () => {
    const old = deferred<SkillListResponse>()
    vi.mocked(skillsApi.list).mockImplementation(async (query) =>
      query?.q === 'old' ? old.promise : result(),
    )
    render(<SkillMarketplacePanel />)
    await screen.findByText('Test skill')
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'old' },
    })
    await waitFor(() =>
      expect(skillsApi.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: 'old' }),
      ),
    )
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'new' },
    })
    await act(async () =>
      old.resolve(result([{ ...skill, label: 'Stale result' }])),
    )
    expect(screen.queryByText('Stale result')).not.toBeInTheDocument()
    await screen.findByText('Test skill')
  })

  it('keeps an enabled skill enabled if persistence fails', async () => {
    vi.mocked(skillsApi.list).mockResolvedValue(
      result([{ ...skill, installed: true, installationId: 'local/test' }]),
    )
    vi.mocked(skillsApi.setEnabled).mockRejectedValue(new Error('Cannot save'))
    render(<SkillMarketplacePanel />)
    await userEvent.setup().click(await screen.findByRole('switch'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot save')
    expect(screen.getByRole('switch')).toBeChecked()
  })

  it('installs a market skill then exposes its enabled switch', async () => {
    vi.mocked(skillsApi.install).mockImplementation(async () => {
      const installed = {
        ...skill,
        installed: true,
        installationId: 'local/test',
      }
      vi.mocked(skillsApi.list).mockResolvedValue(result([installed]))
      return { skill: installed }
    })
    render(<SkillMarketplacePanel />)
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'skillMarketInstall' }))
    expect(await screen.findByRole('switch')).toBeChecked()
    expect(skillsApi.install).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'remote',
        name: 'test',
        version: undefined,
      }),
    )
  })

  it('can recover when typing and clearing before the debounce finishes', async () => {
    render(<SkillMarketplacePanel />)
    await screen.findByText('Test skill')
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'react' },
    })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    await screen.findByText('Test skill')
  })

  it('distinguishes network errors from empty search results', async () => {
    render(<SkillMarketplacePanel />)
    await screen.findByText('Test skill')
    vi.mocked(skillsApi.list).mockRejectedValue(new Error('Search offline'))
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'react' },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('Search offline')
    expect(screen.queryByText('skillSearchEmpty')).not.toBeInTheDocument()
    vi.mocked(skillsApi.list).mockResolvedValue(result([]))
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'unknown' },
    })
    await screen.findByText('skillSearchEmpty')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('toggles and uninstalls using the canonical installation id, not the marketplace id', async () => {
    const installed = {
      ...skill,
      installed: true,
      installationId: 'local/test',
    }
    vi.mocked(skillsApi.list).mockResolvedValue(result([installed]))
    const user = userEvent.setup()
    render(<SkillMarketplacePanel projectId="project-a" />)
    await user.click(await screen.findByRole('switch'))
    await waitFor(() =>
      expect(skillsApi.setEnabled).toHaveBeenCalledWith(
        'local/test',
        false,
        'project-a',
      ),
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'extensionActions' }),
      ).not.toBeDisabled(),
    )
    await user.click(screen.getByRole('button', { name: 'extensionActions' }))
    await user.click(
      screen.getByRole('menuitem', { name: 'skillMarketUninstall' }),
    )
    expect(skillsApi.uninstall).not.toHaveBeenCalled()
    await user.click(
      screen.getByRole('button', { name: 'skillMarketUninstall' }),
    )
    await waitFor(() =>
      expect(skillsApi.uninstall).toHaveBeenCalledWith('local/test'),
    )
  })
})
