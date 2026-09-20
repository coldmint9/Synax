import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectApi } from '../../../lib/api/project'
import { listRemoteDirectories, type RemoteDirectoryListing } from '../../../lib/api/fs'
import { listWslDistributions } from '../../../lib/api/wsl'
import type { ProjectSummary } from '../../state/shellStore'
import { resolveSessionsEntryPath } from '../sessions/sessionLastVisit'
import { ProjectCreateDialog } from './ProjectCreateDialog'

const { navigate, nativePicker } = vi.hoisted(() => ({ navigate: vi.fn(), nativePicker: vi.fn() }))

vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }))
vi.mock('../../../lib/api/project', () => ({
  projectApi: { listProjects: vi.fn(), createWorkspace: vi.fn(), createProject: vi.fn() },
}))
vi.mock('../../../lib/api/fs', () => ({ listRemoteDirectories: vi.fn() }))
vi.mock('../../../lib/api/wsl', () => ({ listWslDistributions: vi.fn() }))
// Exercise the Electron branch too: its native helper only returns one directory.
vi.mock('../../../lib/open-directory-picker', () => ({ isElectron: true, openDirectoryPicker: nativePicker }))

function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'existing', name: 'Existing', status: 'healthy', environment: 'development',
    healthScore: 100, activeAgents: 0, activeHumans: 1, openRisks: 0, updatedAt: 'now',
    source: { kind: 'localPath', localPath: '/repos/existing' },
    ...overrides,
  }
}

function directoryListing(): RemoteDirectoryListing {
  return {
    path: '/repos', name: 'repos', parent: '/', home: '/repos', shortcuts: [], truncated: false,
    entries: [
      { name: 'api', path: '/repos/api', hidden: false },
      { name: 'web', path: '/repos/web', hidden: false },
    ],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function addPath(path: string) {
  fireEvent.click(screen.getByRole('tab', { name: '本地目录' }))
  fireEvent.change(screen.getByRole('textbox', { name: '项目目录路径' }), { target: { value: path } })
  fireEvent.click(screen.getByRole('button', { name: '添加' }))
}

async function renderDialog(onClose = vi.fn()) {
  const view = render(<ProjectCreateDialog open onClose={onClose} />)
  await waitFor(() => expect(projectApi.listProjects).toHaveBeenCalled())
  return { ...view, onClose }
}

describe('ProjectCreateDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(projectApi.listProjects).mockReset().mockResolvedValue({ items: [project()], total: 1 })
    vi.mocked(projectApi.createWorkspace).mockReset()
    vi.mocked(listRemoteDirectories).mockReset().mockResolvedValue(directoryListing())
    vi.mocked(listWslDistributions).mockReset().mockResolvedValue({ available: true, items: [{ name: 'Ubuntu', version: 2, default: true }] })
  })


  it('creates a WSL2 workspace with distribution plus Linux path', async () => {
    const userAgent = vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    vi.mocked(projectApi.createWorkspace).mockResolvedValueOnce({ project: project({ id: 'wsl' }) })
    const { onClose } = await renderDialog()
    await waitFor(() => expect(listWslDistributions).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'WSL2' }))
    const pathInput = screen.getByRole('textbox', { name: '项目目录路径' })
    fireEvent.change(pathInput, { target: { value: '/home/dev/app' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    fireEvent.click(screen.getByRole('button', { name: '创建工作区' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(projectApi.createWorkspace).toHaveBeenCalledWith({
      name: 'app',
      roots: [{ location: { kind: 'wsl', distribution: 'Ubuntu', path: '/home/dev/app' }, name: 'app' }],
    })
    userAgent.mockRestore()
  })

  it('browses multiple directories on Electron and submits all roots in one request despite repeated clicks', async () => {
    const pending = deferred<{ project: ProjectSummary }>()
    vi.mocked(projectApi.createWorkspace).mockReturnValueOnce(pending.promise)
    const user = userEvent.setup()
    const { onClose } = await renderDialog()
    const dialog = screen.getByRole('dialog', { name: '创建工作区' })
    expect(dialog).toHaveAttribute('aria-describedby', 'workspace-create-intro')
    expect(screen.getByRole('list', { name: '工作区项目' })).toHaveClass('overflow-y-auto')
    expect(screen.getByRole('textbox', { name: '工作区名称' })).toHaveFocus()

    const browse = screen.getByRole('button', { name: '浏览' })
    await user.click(browse)
    expect(dialog.closest('.dialog-overlay')).toHaveAttribute('inert')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    await user.click(await screen.findByRole('checkbox', { name: '选择 api' }))
    await user.click(screen.getByRole('checkbox', { name: '选择 web' }))
    await user.click(screen.getByRole('button', { name: '添加所选项目 (2)' }))
    expect(browse).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent('已选择 2 个项目')
    expect(nativePicker).not.toHaveBeenCalled()
    expect(projectApi.createWorkspace).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: '工作区名称' })).toHaveValue('api')

    const submit = screen.getByRole('button', { name: '创建工作区' })
    act(() => {
      fireEvent.click(submit)
      fireEvent.click(submit)
    })
    expect(projectApi.createWorkspace).toHaveBeenCalledTimes(1)
    expect(projectApi.createWorkspace).toHaveBeenCalledWith({
      name: 'api', roots: [{ localPath: '/repos/api', name: 'api' }, { localPath: '/repos/web', name: 'web' }],
    })
    expect(projectApi.createProject).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '创建中…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: '工作区名称' })).toBeDisabled()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(dialog.closest('.dialog-overlay')!)
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => pending.resolve({ project: project({ id: 'created-workspace' }) }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledExactlyOnceWith(resolveSessionsEntryPath('created-workspace'))
  })

  it('adds existing projects by id, deduplicates paths and preserves the chosen default root order', async () => {
    vi.mocked(projectApi.listProjects).mockResolvedValueOnce({
      items: [project(), project({ id: 'without-path', name: 'Scratch', source: { kind: 'scratch' } })], total: 2,
    })
    vi.mocked(projectApi.createWorkspace).mockResolvedValueOnce({ project: project({ id: 'created' }) })
    const { onClose } = await renderDialog()
    fireEvent.click(screen.getByRole('tab', { name: '已有项目' }))
    expect(screen.queryByRole('button', { name: /Scratch/ })).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: /Existing.*repos/ }))
    addPath('  /repos/existing  ')
    expect(screen.getByRole('status')).toHaveTextContent('已选择 1 个项目')
    fireEvent.click(screen.getByRole('tab', { name: '已有项目' }))
    expect(screen.getByRole('button', { name: /Existing.*repos/ })).toBeDisabled()
    addPath('/repos/new')
    const newMember = screen.getByText('/repos/new').closest('[role="listitem"]')!
    fireEvent.click(within(newMember as HTMLElement).getByRole('button', { name: '设为默认: new' }))
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('new默认项目')
    fireEvent.change(screen.getByRole('textbox', { name: '工作区名称' }), { target: { value: '  My workspace  ' } })
    fireEvent.click(screen.getByRole('button', { name: '创建工作区' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(projectApi.createWorkspace).toHaveBeenCalledExactlyOnceWith({
      name: 'My workspace', roots: [{ localPath: '/repos/new', name: 'new' }, { projectId: 'existing' }],
    })
    expect(projectApi.createProject).not.toHaveBeenCalled()
  })

  it('removes members, re-enables their existing option and accepts a workspace with just one root', async () => {
    vi.mocked(projectApi.createWorkspace).mockResolvedValueOnce({ project: project({ id: 'single' }) })
    const { onClose } = await renderDialog()
    expect(screen.getByRole('button', { name: '创建工作区' })).toBeDisabled()
    fireEvent.click(screen.getByRole('tab', { name: '已有项目' }))
    fireEvent.click(await screen.findByRole('button', { name: /Existing.*repos/ }))
    fireEvent.click(screen.getByRole('button', { name: '移除 Existing' }))
    expect(screen.getByRole('button', { name: /Existing.*repos/ })).toBeEnabled()
    expect(screen.getByRole('status')).toHaveTextContent('已选择 0 个项目')
    expect(screen.getByRole('button', { name: '创建工作区' })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: '工作区名称' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('tab', { name: '本地目录' }))
    const input = screen.getByRole('textbox', { name: '项目目录路径' })
    fireEvent.change(input, { target: { value: 'C:\\repos\\single' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(screen.getByRole('status')).toHaveTextContent('已选择 0 个项目')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('textbox', { name: '工作区名称' })).toHaveValue('single')
    fireEvent.click(screen.getByRole('button', { name: '创建工作区' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(projectApi.createWorkspace).toHaveBeenCalledExactlyOnceWith({
      name: 'single', roots: [{ localPath: 'C:\\repos\\single', name: 'single' }],
    })
  })

  it('keeps the name and selected roots after a submission error and retries the same payload', async () => {
    vi.mocked(projectApi.createWorkspace)
      .mockRejectedValueOnce(new Error('创建失败，请重试'))
      .mockResolvedValueOnce({ project: project({ id: 'retried' }) })
    const { onClose } = await renderDialog()
    fireEvent.click(screen.getByRole('tab', { name: '已有项目' }))
    fireEvent.click(await screen.findByRole('button', { name: /Existing.*repos/ }))
    addPath('/repos/api')
    fireEvent.change(screen.getByRole('textbox', { name: '工作区名称' }), { target: { value: 'Kept name' } })
    fireEvent.click(screen.getByRole('button', { name: '创建工作区' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('创建失败，请重试')
    expect(screen.getByRole('status')).toHaveTextContent('已选择 2 个项目')
    expect(screen.getByRole('textbox', { name: '工作区名称' })).toHaveValue('Kept name')
    expect(screen.getByRole('button', { name: '移除 Existing' })).toBeEnabled()
    fireEvent.click(screen.getByRole('tab', { name: '已有项目' }))
    expect(screen.getByRole('button', { name: /Existing.*repos/ })).toBeDisabled()
    expect(onClose).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '创建工作区' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(projectApi.createWorkspace).toHaveBeenCalledTimes(2)
    expect(vi.mocked(projectApi.createWorkspace).mock.calls[1][0]).toEqual(vi.mocked(projectApi.createWorkspace).mock.calls[0][0])
  })

  it('allows manual paths when loading existing projects fails', async () => {
    vi.mocked(projectApi.listProjects).mockRejectedValueOnce(new Error('项目列表不可用'))
    render(<ProjectCreateDialog open onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: '已有项目' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('项目列表不可用')
    addPath('/repos/api')
    expect(screen.getByRole('button', { name: '创建工作区' })).toBeEnabled()
    expect(screen.getByRole('status')).toHaveTextContent('已选择 1 个项目')
  })

  it('closes only the top dialog on Escape, traps and restores focus, and clears cancelled openings', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    function Harness() {
      const [open, setOpen] = useState(false)
      return <>
        <button onClick={() => setOpen(true)}>打开创建工作区</button>
        <ProjectCreateDialog open={open} onClose={() => { onClose(); setOpen(false) }} />
      </>
    }
    render(<Harness />)
    const opener = screen.getByRole('button', { name: '打开创建工作区' })
    await user.click(opener)
    await waitFor(() => expect(projectApi.listProjects).toHaveBeenCalled())
    addPath('/repos/kept')
    screen.getByRole('button', { name: '关闭' }).focus()
    await user.tab({ shift: true })
    expect(screen.getByRole('button', { name: '创建工作区' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: '关闭' })).toHaveFocus()
    const browse = screen.getByRole('button', { name: '浏览' })
    await user.click(browse)
    await user.click(await screen.findByRole('checkbox', { name: '选择 api' }))
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    expect(browse).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent('已选择 1 个项目')
    await user.click(browse)
    await screen.findByRole('checkbox', { name: '选择 api' })
    expect(screen.getByRole('status')).toHaveTextContent('已选择 0 个项目')
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(browse).toHaveFocus()
    fireEvent.click(screen.getByRole('tab', { name: '本地目录' }))
  fireEvent.change(screen.getByRole('textbox', { name: '项目目录路径' }), { target: { value: '/unfinished' } })
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(opener).toHaveFocus()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(opener)
    await waitFor(() => expect(projectApi.listProjects).toHaveBeenCalled())
    expect(screen.getByRole('textbox', { name: '工作区名称' })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: '项目目录路径' })).toHaveValue('')
    expect(screen.getByRole('status')).toHaveTextContent('已选择 0 个项目')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(projectApi.createWorkspace).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(opener).toHaveFocus()
  })

  it.each(['resolve', 'reject'] as const)('ignores an old project list that later %ss after closing and reopening', async outcome => {
    const old = deferred<{ items: ProjectSummary[]; total: number }>()
    const fresh = project({ id: 'fresh', name: 'Fresh', source: { kind: 'localPath', localPath: '/repos/fresh' } })
    vi.mocked(projectApi.listProjects).mockReturnValueOnce(old.promise).mockResolvedValueOnce({ items: [fresh], total: 1 })
    const onClose = vi.fn()
    const { rerender } = render(<ProjectCreateDialog open onClose={onClose} />)
    rerender(<ProjectCreateDialog open={false} onClose={onClose} />)
    rerender(<ProjectCreateDialog open onClose={onClose} />)
    fireEvent.click(screen.getByRole('tab', { name: '已有项目' }))
    await screen.findByRole('button', { name: /Fresh.*repos/ })
    await act(async () => {
      if (outcome === 'resolve') old.resolve({ items: [project()], total: 1 })
      else old.reject(new Error('old list failed'))
    })
    expect(screen.getByRole('button', { name: /Fresh.*repos/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Existing.*repos/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'] as const)('ignores an old submission that later %ss without unlocking or closing a new submission', async outcome => {
    const old = deferred<{ project: ProjectSummary }>()
    const fresh = deferred<{ project: ProjectSummary }>()
    vi.mocked(projectApi.createWorkspace).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const { rerender, onClose } = await renderDialog()
    addPath('/repos/old')
    fireEvent.click(screen.getByRole('button', { name: '创建工作区' }))
    rerender(<ProjectCreateDialog open={false} onClose={onClose} />)
    rerender(<ProjectCreateDialog open onClose={onClose} />)
    await waitFor(() => expect(projectApi.listProjects).toHaveBeenCalled())
    expect(screen.getByRole('status')).toHaveTextContent('已选择 0 个项目')
    addPath('/repos/fresh')
    fireEvent.click(screen.getByRole('button', { name: '创建工作区' }))
    await act(async () => {
      if (outcome === 'resolve') old.resolve({ project: project({ id: 'old-workspace' }) })
      else old.reject(new Error('old submission failed'))
    })
    expect(screen.getByRole('button', { name: '创建中…' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: '工作区名称' })).toHaveValue('fresh')
    expect(screen.getByRole('status')).toHaveTextContent('已选择 1 个项目')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '创建中…' }))
    expect(projectApi.createWorkspace).toHaveBeenCalledTimes(2)
    await act(async () => fresh.resolve({ project: project({ id: 'fresh-workspace' }) }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledExactlyOnceWith(resolveSessionsEntryPath('fresh-workspace'))
  })
  it('searches existing projects by path and blocks duplicate paths with trailing separators', async () => {
    await renderDialog()
    fireEvent.click(screen.getByRole('tab', { name: '已有项目' }))
    const search = screen.getByRole('textbox', { name: '搜索名称或路径' })
    fireEvent.change(search, { target: { value: 'no-such-project' } })
    expect(screen.getByText('没有匹配的项目')).toBeInTheDocument()
    fireEvent.change(search, { target: { value: '/repos/' } })
    fireEvent.click(await screen.findByRole('button', { name: /Existing.*repos/ }))
    addPath('/repos/existing/')
    expect(screen.getByRole('button', { name: '添加', exact: true })).toBeDisabled()
    expect(screen.getByText('此目录已在工作区中。')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    fireEvent.keyDown(screen.getByRole('textbox', { name: '项目目录路径' }), { key: 'Enter' })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

})
