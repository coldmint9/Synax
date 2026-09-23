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
} from '../../../../lib/api/extensions'
vi.mock('../../../../hooks/useLocale', () => ({
  useLocale: () => ({ locale: 'zh', t: (key: string) => key }),
}))
vi.mock('../../../../lib/api/extensions', () => ({
  extensionsApi: {
    list: vi.fn(),
    sources: vi.fn(),
    detail: vi.fn(),
    install: vi.fn(),
    changeState: vi.fn(),
    saveCustom: vi.fn(),
  },
}))
vi.mock('../../../../lib/api/config', () => ({
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
    expect(dialog).toHaveClass('extension-drawer')
    const wrapper = dialog.closest('[data-slot="drawer-content"]')
    expect(wrapper).toHaveAttribute('data-placement', 'right')
    expect(wrapper?.className).not.toContain('max-w-')
  })

  it('shows local discovery as a market source alongside type filters', async () => {
    render(
      <ExtensionCenter
        projectId="project-a"
        section="market"
        onNavigate={vi.fn()}
      />,
    )
    await screen.findByText('读取文件')
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '管理来源' })).toBeInTheDocument()
    expect(extensionsApi.list).toHaveBeenCalledWith(
      'project-a',
      expect.objectContaining({ view: 'market' }),
    )
    // HeroUI exposes selection controls as buttons with their field label.
    expect(screen.getByLabelText('来源')).toBeInTheDocument()
    expect(screen.getByLabelText('类型')).toBeInTheDocument()
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
