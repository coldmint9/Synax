import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectApi, type ProjectWorkspace, type ProjectWorkspaceRoot } from '../../../../lib/api/project'
import { openDirectoryPicker } from '../../../../lib/open-directory-picker'
import type { ProjectSummary } from '../../../state/shellStore'
import { ProjectReferencesSection } from './ProjectReferencesSection'

type MockButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  children: ReactNode | ((state: { isPending: boolean }) => ReactNode)
  onPress?: () => void
  isDisabled?: boolean
  isPending?: boolean
}

// Match the settings page convention: preserve native submit/disabled behavior
// and HeroUI's onPress and render-function children.
vi.mock('@heroui/react', () => ({
  Button: ({ children, onPress, isDisabled, isPending = false, type = 'button', 'aria-label': ariaLabel }: MockButtonProps) => (
    <button type={type} aria-label={ariaLabel} onClick={onPress} disabled={isDisabled || isPending}>
      {typeof children === 'function' ? children({ isPending }) : children}
    </button>
  ),
}))

vi.mock('../../../../hooks/useLocale', () => ({
  useLocale: () => ({ locale: 'en' }),
}))

vi.mock('../../../../lib/api/project', () => ({
  projectApi: {
    getWorkspace: vi.fn(),
    listProjects: vi.fn(),
    addReference: vi.fn(),
    removeReference: vi.fn(),
  },
}))

vi.mock('../../../../lib/open-directory-picker', () => ({
  isElectron: true,
  openDirectoryPicker: vi.fn(),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function workspace(projectId: string, references: ProjectWorkspaceRoot[] = []): ProjectWorkspace {
  return {
    roots: [
      { id: projectId, name: projectId, path: `/work/${projectId}`, role: 'primary', status: 'available' },
      ...references,
    ],
  }
}

function project(id: string, localPath?: string): ProjectSummary {
  return {
    id, name: id, status: 'healthy', environment: 'development', healthScore: 100,
    activeAgents: 0, activeHumans: 1, openRisks: 0, updatedAt: 'just now',
    source: { kind: 'localPath', localPath },
  }
}

const reference: ProjectWorkspaceRoot = {
  id: 'ref-independent-id', name: 'Shared library', path: '/work/shared', role: 'reference', status: 'available',
}

const pathInput = () => screen.getByRole('textbox', { name: 'Absolute directory path' })
const nameInput = () => screen.getByRole('textbox', { name: 'Reference name (optional)' })
const addButton = () => screen.getByRole('button', { name: 'Add reference' })
const removeButton = () => screen.getByRole('button', { name: 'Remove reference: Shared library (/work/shared)' })

async function ready(projectId = 'project-a') {
  await screen.findByText(`/work/${projectId}`)
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Add from' })).toBeEnabled())
}

describe('ProjectReferencesSection', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(projectApi.getWorkspace).mockImplementation(async id => workspace(id))
    vi.mocked(projectApi.listProjects).mockResolvedValue({ items: [], total: 0 })
    vi.mocked(projectApi.addReference).mockResolvedValue(workspace('project-a', [reference]))
    vi.mocked(projectApi.removeReference).mockResolvedValue(workspace('project-a'))
    vi.mocked(openDirectoryPicker).mockResolvedValue(null)
  })

  it.each([
    { name: '  Shared library  ', expected: { localPath: '/work/shared', name: 'Shared library' } },
    { name: '   ', expected: { localPath: '/work/shared' } },
  ])('adds a trimmed local path with optional name "$name"', async ({ name, expected }) => {
    const user = userEvent.setup()
    render(<ProjectReferencesSection projectId="project-a" />)
    await ready()

    expect(addButton()).toBeDisabled()
    await user.type(pathInput(), '  /work/shared  ')
    await user.type(nameInput(), name)
    await user.click(addButton())

    expect(projectApi.addReference).toHaveBeenCalledExactlyOnceWith('project-a', expected)
    expect(await screen.findByText('/work/shared')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Reference added.')
    expect(pathInput()).toHaveValue('')
    expect(nameInput()).toHaveValue('')
    expect(addButton()).toBeDisabled()
  })

  it('adds an existing project by project ID and excludes the current project and projects without a local path', async () => {
    const user = userEvent.setup()
    const items = [project('project-a', '/work/project-a'), project('project-b', '/work/project-b'), project('remote-only'), project('blank-path', '   ')]
    vi.mocked(projectApi.listProjects).mockResolvedValue({ items, total: items.length })
    vi.mocked(projectApi.addReference).mockResolvedValue(workspace('project-a', [{ ...reference, path: '/work/project-b' }]))
    render(<ProjectReferencesSection projectId="project-a" />)
    await ready()

    await user.selectOptions(screen.getByRole('combobox', { name: 'Add from' }), 'existing')
    const select = screen.getByRole('combobox', { name: 'Select project' })
    expect(screen.getAllByRole('option').map(option => option.getAttribute('value'))).toEqual(['local', 'existing', '', 'project-b'])
    expect(addButton()).toBeDisabled()
    await user.selectOptions(select, 'project-b')
    await user.click(addButton())

    expect(projectApi.addReference).toHaveBeenCalledExactlyOnceWith('project-a', { projectId: 'project-b' })
    expect(await screen.findByRole('status')).toHaveTextContent('Reference added.')
    expect(screen.getByText('/work/project-b')).toBeInTheDocument()
    expect(select).toHaveValue('')
    expect(addButton()).toBeDisabled()
  })

  it('unlinks using the independent reference ID and preserves the primary directory', async () => {
    const user = userEvent.setup()
    vi.mocked(projectApi.getWorkspace).mockResolvedValue(workspace('project-a', [reference]))
    render(<ProjectReferencesSection projectId="project-a" />)
    await ready()

    expect(screen.getAllByRole('button', { name: /^Remove reference:/ })).toHaveLength(1)
    await user.click(removeButton())

    expect(projectApi.removeReference).toHaveBeenCalledExactlyOnceWith('project-a', 'ref-independent-id')
    expect(await screen.findByRole('status')).toHaveTextContent('Reference removed and files preserved.')
    expect(screen.queryByText('/work/shared')).not.toBeInTheDocument()
    expect(screen.getByText('/work/project-a')).toBeInTheDocument()
  })

  it('shows a workspace API failure and allows refreshing to recover', async () => {
    const user = userEvent.setup()
    vi.mocked(projectApi.getWorkspace).mockRejectedValueOnce(new Error('Workspace unavailable'))
    render(<ProjectReferencesSection projectId="project-a" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load project directories: Workspace unavailable')
    expect(screen.queryByRole('button', { name: 'Add reference' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Refresh directories and projects' }))
    await ready()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows a project-list API failure and disables existing-project selection', async () => {
    const user = userEvent.setup()
    vi.mocked(projectApi.listProjects).mockRejectedValueOnce(new Error('Projects unavailable'))
    render(<ProjectReferencesSection projectId="project-a" />)
    await ready()

    await user.selectOptions(screen.getByRole('combobox', { name: 'Add from' }), 'existing')

    expect(projectApi.listProjects).toHaveBeenCalledWith(undefined, { throwOnError: true })
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load existing projects. Refresh to retry: Projects unavailable')
    expect(screen.getByRole('combobox', { name: 'Select project' })).toBeDisabled()
    expect(addButton()).toBeDisabled()
  })

  it('shows an add API failure and retains input for retry', async () => {
    const user = userEvent.setup()
    vi.mocked(projectApi.addReference).mockRejectedValueOnce(new Error('Directory does not exist'))
    render(<ProjectReferencesSection projectId="project-a" />)
    await ready()

    await user.type(pathInput(), '/work/missing')
    await user.type(nameInput(), 'Missing')
    await user.click(addButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to add reference: Directory does not exist')
    expect(pathInput()).toHaveValue('/work/missing')
    expect(nameInput()).toHaveValue('Missing')
    expect(addButton()).toBeEnabled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows an unlink API failure and retains the reference', async () => {
    const user = userEvent.setup()
    vi.mocked(projectApi.getWorkspace).mockResolvedValue(workspace('project-a', [reference]))
    vi.mocked(projectApi.removeReference).mockRejectedValueOnce(new Error('Reference is locked'))
    render(<ProjectReferencesSection projectId="project-a" />)
    await ready()

    await user.click(removeButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to remove reference: Reference is locked')
    expect(screen.getByText('/work/shared')).toBeInTheDocument()
    expect(removeButton()).toBeEnabled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('ignores A’s delayed workspace and project list after switching to B', async () => {
    const user = userEvent.setup()
    const slowWorkspace = deferred<ProjectWorkspace>()
    const slowProjects = deferred<Awaited<ReturnType<typeof projectApi.listProjects>>>()
    vi.mocked(projectApi.getWorkspace).mockReturnValueOnce(slowWorkspace.promise)
    vi.mocked(projectApi.listProjects).mockReturnValueOnce(slowProjects.promise)
      .mockResolvedValueOnce({ items: [project('b-choice', '/work/b-choice')], total: 1 })
    const view = render(<ProjectReferencesSection projectId="project-a" />)
    expect(projectApi.getWorkspace).toHaveBeenCalledWith('project-a')

    view.rerender(<ProjectReferencesSection projectId="project-b" />)
    await ready('project-b')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Add from' }), 'existing')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Select project' }), 'b-choice')

    await act(async () => {
      slowWorkspace.resolve(workspace('project-a', [reference]))
      slowProjects.resolve({ items: [project('a-choice', '/work/a-choice')], total: 1 })
      await Promise.all([slowWorkspace.promise, slowProjects.promise])
    })

    expect(screen.getByText('/work/project-b')).toBeInTheDocument()
    expect(screen.queryByText('/work/project-a')).not.toBeInTheDocument()
    expect(screen.queryByText('/work/shared')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Select project' })).toHaveValue('b-choice')
    expect(screen.queryByRole('option', { name: /a-choice/ })).not.toBeInTheDocument()
    expect(addButton()).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it.each(['success', 'failure'] as const)('ignores A’s delayed add %s after switching to B', async outcome => {
    const user = userEvent.setup()
    const slowAdd = deferred<ProjectWorkspace>()
    vi.mocked(projectApi.addReference).mockReturnValueOnce(slowAdd.promise)
    const view = render(<ProjectReferencesSection projectId="project-a" />)
    await ready()
    await user.type(pathInput(), '/work/shared')
    await user.click(addButton())
    expect(projectApi.addReference).toHaveBeenCalledExactlyOnceWith('project-a', { localPath: '/work/shared' })

    view.rerender(<ProjectReferencesSection projectId="project-b" />)
    await ready('project-b')
    expect(pathInput()).toHaveValue('')
    await user.type(pathInput(), '/work/b-draft')
    await user.type(nameInput(), 'B draft')

    await act(async () => {
      if (outcome === 'success') slowAdd.resolve(workspace('project-a', [reference]))
      else slowAdd.reject(new Error('Stale A failure'))
      await slowAdd.promise.catch(() => undefined)
    })

    expect(screen.getByText('/work/project-b')).toBeInTheDocument()
    expect(screen.queryByText('/work/project-a')).not.toBeInTheDocument()
    expect(screen.queryByText('/work/shared')).not.toBeInTheDocument()
    expect(pathInput()).toHaveValue('/work/b-draft')
    expect(nameInput()).toHaveValue('B draft')
    expect(addButton()).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('ignores A’s directory picker result after switching to B', async () => {
    const user = userEvent.setup()
    const picker = deferred<Awaited<ReturnType<typeof openDirectoryPicker>>>()
    vi.mocked(openDirectoryPicker).mockReturnValueOnce(picker.promise)
    const view = render(<ProjectReferencesSection projectId="project-a" />)
    await ready()
    await user.click(screen.getByRole('button', { name: 'Choose directory' }))
    expect(openDirectoryPicker).toHaveBeenCalledTimes(1)

    view.rerender(<ProjectReferencesSection projectId="project-b" />)
    await ready('project-b')
    expect(pathInput()).toHaveValue('')
    expect(nameInput()).toHaveValue('')
    // Leave B's name empty so a stale picker auto-filled name is detectable.
    fireEvent.change(pathInput(), { target: { value: '/work/b-draft' } })

    await act(async () => {
      picker.resolve({ path: '/work/a-picked', name: 'A picked' })
      await picker.promise
    })

    expect(screen.getByText('/work/project-b')).toBeInTheDocument()
    expect(pathInput()).toHaveValue('/work/b-draft')
    expect(nameInput()).toHaveValue('')
    expect(addButton()).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Choose directory' })).toBeEnabled()
    expect(projectApi.addReference).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
