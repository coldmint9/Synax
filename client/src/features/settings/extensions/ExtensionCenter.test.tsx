import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtensionCenter } from './ExtensionCenter'
import { SettingsFrame } from './SettingsFrame'
import {
  extensionsApi,
  type ExtensionItem,
  type ExtensionList,
} from '../../../adapters/transport/extensions'
vi.mock('../../../shared/hooks/useLocale', () => ({
  useLocale: () => ({ locale: 'zh', t: (key: string) => key }),
}))
vi.mock('../../../adapters/transport/extensions', () => ({
  extensionsApi: {
    list: vi.fn(),
    sources: vi.fn(),
    detail: vi.fn(),
    install: vi.fn(),
    changeState: vi.fn(),
    saveCustom: vi.fn(),
    saveDirectories: vi.fn(),
  },
}))
vi.mock('../../../adapters/transport/config', () => ({
  configApi: { testMcpServer: vi.fn() },
}))
const tool: ExtensionItem = {
  id: 'file.read',
  name: '读取文件',
  description: '读取项目中的文件',
  kind: 'tool',
  installed: true,
  enabled: true,
  sourceId: 'builtin',
  sourceLabel: 'Synax',
}
const response = (items: ExtensionItem[] = [tool]): ExtensionList => ({
  items,
  total: items.length,
  hasMore: false,
  warnings: [],
})
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(extensionsApi.list).mockResolvedValue(response())
  vi.mocked(extensionsApi.sources).mockResolvedValue({
    items: [{ id: 'local', name: 'Local', description: '', kind: 'local' }],
    directories: [],
  })
})
describe('extension center', () => {
  it('uses one quiet settings navigation, not nested tab bars', () => {
    const select = vi.fn()
    render(
      <SettingsFrame section="skill" projectId="project-a" onSelect={select}>
        <span>content</span>
      </SettingsFrame>,
    )
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '技能' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('button', { name: '工具' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'MCP' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '市场' })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '本地发现' }),
    ).not.toBeInTheDocument()
  })
  it('disables installed tools and preserves the switch if persistence fails', async () => {
    vi.mocked(extensionsApi.changeState).mockRejectedValue(
      new Error('Save failed'),
    )
    render(
      <ExtensionCenter
        projectId="project-a"
        section="tool"
        onNavigate={vi.fn()}
      />,
    )
    const control = await screen.findByRole('switch', {
      name: '启用: 读取文件',
    })
    await userEvent.setup().click(control)
    await waitFor(() =>
      expect(extensionsApi.changeState).toHaveBeenCalledWith(
        'project-a',
        tool,
        'disable',
      ),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('Save failed')
    expect(control).toBeChecked()
  })
  it('allows uninstalling a built-in extension with confirmation', async () => {
    const user = userEvent.setup()
    render(
      <ExtensionCenter
        projectId="project-a"
        section="tool"
        onNavigate={vi.fn()}
      />,
    )
    await user.click(
      await screen.findByRole('button', { name: '更多操作: 读取文件' }),
    )
    await user.click(screen.getByRole('menuitem', { name: '卸载' }))
    expect(extensionsApi.changeState).not.toHaveBeenCalled()
    vi.mocked(extensionsApi.changeState).mockImplementation(async () => {
      vi.mocked(extensionsApi.list).mockResolvedValue(response([]))
    })
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: '卸载',
      }),
    )
    await screen.findByText('这里还没有扩展')
    expect(extensionsApi.changeState).toHaveBeenCalledWith(
      'project-a',
      tool,
      'uninstall',
    )
  })
  it('opens details in a full-viewport positioning wrapper with a bounded dialog', async () => {
    vi.mocked(extensionsApi.detail).mockResolvedValue({ item: tool })
    render(
      <ExtensionCenter
        projectId="project-a"
        section="tool"
        onNavigate={vi.fn()}
      />,
    )
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: '详情: 读取文件' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('data-surface', 'drawer')
    const viewport = dialog.querySelector('.ui-dialog-viewport')
    expect(viewport).toHaveClass('fixed', 'inset-0', 'justify-end')
    expect(viewport?.className).not.toContain('max-w-')
    const panel = dialog.querySelector('.ui-dialog-panel')
    expect(panel).toHaveClass('extension-drawer', 'h-full')
    expect(panel?.parentElement).toHaveClass('max-w-xl')
  })

  it('keeps the marketplace focused on one add entry until the enterprise catalog is available', async () => {
    render(
      <ExtensionCenter
        projectId="project-a"
        section="market"
        onNavigate={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: '新增扩展' })).toBeInTheDocument()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '管理来源' }),
    ).not.toBeInTheDocument()
    expect(extensionsApi.list).not.toHaveBeenCalled()
  })

  it.each(['tool', 'skill', 'mcp'] as const)(
    'keeps %s discovery and installation in its own section',
    async (kind) => {
      const user = userEvent.setup()
      const discovered: ExtensionItem = {
        id: 'custom.local-check',
        name: '项目检查',
        description: '扫描当前项目',
        kind,
        installed: false,
        enabled: false,
        sourceId: 'local',
        sourceLabel: 'Local',
        locator: {
          sourceId: 'local',
          name: '项目检查',
          discoveryId: 'tool-check',
        },
      }
      let installed = false
      const installedItem = {
        ...discovered,
        id: 'canonical-installation',
        installed: true,
        enabled: true,
      }
      vi.mocked(extensionsApi.list).mockImplementation(
        async (_projectId, input) => {
          if (installed) return response([installedItem])
          return input.source === 'local'
            ? response([discovered])
            : response([])
        },
      )
      vi.mocked(extensionsApi.install).mockImplementation(async () => {
        installed = true
        return { id: installedItem.id }
      })
      render(
        <ExtensionCenter
          projectId="project-a"
          section={kind}
          onNavigate={vi.fn()}
        />,
      )
      await screen.findByText('这里还没有扩展')
      expect(extensionsApi.list).not.toHaveBeenCalledWith(
        'project-a',
        expect.objectContaining({ source: 'local' }),
      )
      await user.click(screen.getByRole('tab', { name: '本机发现' }))
      await user.click(
        await screen.findByRole('button', { name: '安装: 项目检查' }),
      )
      expect(extensionsApi.install).toHaveBeenCalledWith(
        'project-a',
        discovered,
      )
      expect(
        await screen.findByRole('switch', { name: '启用: 项目检查' }),
      ).toBeChecked()
      expect(extensionsApi.list).toHaveBeenCalledWith(
        'project-a',
        expect.objectContaining({ view: 'market', source: 'local', kind }),
      )
      await user.click(screen.getByRole('button', { name: '查看已安装' }))
      await user.click(
        await screen.findByRole('switch', { name: '启用: 项目检查' }),
      )
      expect(extensionsApi.changeState).toHaveBeenCalledWith(
        'project-a',
        installedItem,
        'disable',
      )
    },
  )

  it('paginates discovery and resets the query and page when returning to installed', async () => {
    const user = userEvent.setup()
    vi.mocked(extensionsApi.list).mockResolvedValue({
      ...response(),
      total: 61,
      hasMore: true,
    })
    render(
      <ExtensionCenter
        projectId="project-a"
        section="skill"
        onNavigate={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('tab', { name: '本机发现' }))
    await screen.findByText('读取文件')
    await user.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() =>
      expect(extensionsApi.list).toHaveBeenLastCalledWith(
        'project-a',
        expect.objectContaining({ source: 'local', offset: 30 }),
      ),
    )
    await user.type(screen.getByRole('searchbox'), 'review')
    await waitFor(() =>
      expect(extensionsApi.list).toHaveBeenLastCalledWith(
        'project-a',
        expect.objectContaining({ source: 'local', q: 'review', offset: 0 }),
      ),
    )
    await user.click(screen.getByRole('tab', { name: '已安装' }))
    await waitFor(() =>
      expect(extensionsApi.list).toHaveBeenLastCalledWith(
        'project-a',
        expect.objectContaining({
          view: 'installed',
          source: undefined,
          q: undefined,
          offset: 0,
        }),
      ),
    )
  })

  it('saves scan directories within the section without exposing remote sources', async () => {
    const user = userEvent.setup()
    render(
      <ExtensionCenter
        projectId="project-a"
        section="skill"
        onNavigate={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('tab', { name: '本机发现' }))
    await user.click(screen.getByRole('button', { name: '扫描设置' }))
    const dialog = within(screen.getByRole('dialog'))
    const directories = dialog.getByRole('textbox', {
      name: '附加扫描目录（每行一个，最多 8 个）',
    })
    await waitFor(() => expect(directories).toBeEnabled())
    expect(dialog.queryByText('添加远程源')).not.toBeInTheDocument()
    await user.type(directories, '/tmp/tools\n/tmp/skills')
    const calls = vi.mocked(extensionsApi.list).mock.calls.length
    await user.click(dialog.getByRole('button', { name: '保存并重新扫描' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    )
    expect(extensionsApi.saveDirectories).toHaveBeenCalledWith('project-a', [
      '/tmp/tools',
      '/tmp/skills',
    ])
    await waitFor(() =>
      expect(extensionsApi.list).toHaveBeenCalledTimes(calls + 1),
    )
  })

  it('offers reinstalling built-in tools without visiting the marketplace', async () => {
    const user = userEvent.setup()
    vi.mocked(extensionsApi.list).mockImplementation(
      async (_projectId, input) =>
        input.source === 'builtin'
          ? response([{ ...tool, installed: false, enabled: false }])
          : response([]),
    )
    render(
      <ExtensionCenter
        projectId="project-a"
        section="tool"
        onNavigate={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('tab', { name: 'Synax 内置' }))
    await user.click(
      await screen.findByRole('button', { name: '安装: 读取文件' }),
    )
    expect(extensionsApi.install).toHaveBeenCalledWith(
      'project-a',
      expect.objectContaining({ id: tool.id }),
    )
    expect(extensionsApi.list).toHaveBeenLastCalledWith(
      'project-a',
      expect.objectContaining({ source: 'builtin', kind: 'tool' }),
    )
  })

  it('navigates to the correct management section after adding from the marketplace', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()
    render(
      <ExtensionCenter
        projectId="project-a"
        section="market"
        onNavigate={navigate}
      />,
    )
    await user.click(screen.getByRole('button', { name: '新增扩展' }))
    const dialog = within(screen.getByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: '类型' }))
    await user.click(screen.getByRole('option', { name: '技能' }))
    await user.type(dialog.getByRole('textbox', { name: '名称' }), 'Review')
    await user.type(
      dialog.getByRole('textbox', { name: '用途说明' }),
      'Review changes',
    )
    await user.type(
      dialog.getByRole('textbox', { name: '技能内容' }),
      'Inspect the diff.',
    )
    await user.click(dialog.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('skill'))
    expect(extensionsApi.list).not.toHaveBeenCalled()
  })
  it('keeps the selected view when an older discovery response finishes late', async () => {
    const user = userEvent.setup()
    let resolve!: (value: ExtensionList) => void
    const deferred = new Promise<ExtensionList>((done) => {
      resolve = done
    })
    vi.mocked(extensionsApi.list).mockImplementation(async (_project, input) =>
      input.source === 'local' ? deferred : response(),
    )
    render(
      <ExtensionCenter
        projectId="project-a"
        section="tool"
        onNavigate={vi.fn()}
      />,
    )
    await screen.findByText('读取文件')
    await user.click(screen.getByRole('tab', { name: '本机发现' }))
    await user.click(screen.getByRole('tab', { name: '已安装' }))
    await screen.findByText('读取文件')
    await act(async () =>
      resolve(response([{ ...tool, name: 'Late discovered tool' }])),
    )
    expect(screen.queryByText('Late discovered tool')).not.toBeInTheDocument()
    expect(screen.getByText('读取文件')).toBeInTheDocument()
  })

  it('preserves directory input when saving scan settings fails', async () => {
    const user = userEvent.setup()
    vi.mocked(extensionsApi.saveDirectories).mockRejectedValue(
      new Error('Cannot save directories'),
    )
    render(
      <ExtensionCenter
        projectId="project-a"
        section="tool"
        onNavigate={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('tab', { name: '本机发现' }))
    await user.click(screen.getByRole('button', { name: '扫描设置' }))
    const dialog = within(screen.getByRole('dialog'))
    const input = dialog.getByRole('textbox')
    await waitFor(() => expect(input).toBeEnabled())
    await user.type(input, '/tmp/my-tools')
    await user.click(dialog.getByRole('button', { name: '保存并重新扫描' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent(
      'Cannot save directories',
    )
    expect(input).toHaveValue('/tmp/my-tools')
  })

  it('does not let an older search overwrite a new query during debounce', async () => {
    let resolve!: (value: ExtensionList) => void
    const deferred = new Promise<ExtensionList>((r) => {
      resolve = r
    })
    vi.mocked(extensionsApi.list).mockImplementation(async (_, query) =>
      query.q === 'older' ? deferred : response(),
    )
    render(
      <ExtensionCenter
        projectId="project-a"
        section="tool"
        onNavigate={vi.fn()}
      />,
    )
    await screen.findByText('读取文件')
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'older' },
    })
    await waitFor(() =>
      expect(extensionsApi.list).toHaveBeenLastCalledWith(
        'project-a',
        expect.objectContaining({ q: 'older' }),
      ),
    )
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'newer' },
    })
    await act(async () =>
      resolve(response([{ ...tool, name: 'Outdated result' }])),
    )
    expect(screen.queryByText('Outdated result')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(extensionsApi.list).toHaveBeenLastCalledWith(
        'project-a',
        expect.objectContaining({ q: 'newer' }),
      ),
    )
  })
  it('creates a real custom skill rather than only adding a display row', async () => {
    const user = userEvent.setup()
    render(
      <ExtensionCenter
        projectId="project-a"
        section="skill"
        onNavigate={vi.fn()}
      />,
    )
    await screen.findByText('读取文件')
    await user.click(screen.getByRole('button', { name: '自定义' }))
    const dialog = within(screen.getByRole('dialog'))
    await user.type(dialog.getByRole('textbox', { name: '名称' }), 'Review')
    await user.type(
      dialog.getByRole('textbox', { name: '用途说明' }),
      'Review changes',
    )
    await user.type(
      dialog.getByRole('textbox', { name: '技能内容' }),
      'Inspect the diff carefully.',
    )
    await user.click(dialog.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(extensionsApi.saveCustom).toHaveBeenCalledWith(
        'project-a',
        expect.objectContaining({
          kind: 'skill',
          name: 'Review',
          content: 'Inspect the diff carefully.',
        }),
      ),
    )
  })
})
