import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CustomExtensionEditor } from './CustomExtensionEditor'
import { extensionsApi } from '../../../adapters/transport/extensions'
import { configApi } from '../../../adapters/transport/config'

vi.mock('../../../shared/hooks/useLocale', () => ({ useLocale: () => ({ locale: 'zh', t: (key: string) => key }) }))
vi.mock('../../../adapters/transport/extensions', () => ({ extensionsApi: { saveCustom: vi.fn() } }))
vi.mock('../../../adapters/transport/config', () => ({ configApi: { testMcpServer: vi.fn() } }))
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(extensionsApi.saveCustom).mockResolvedValue({} as never)
  vi.mocked(configApi.testMcpServer).mockResolvedValue({ ok: true, tools: [] })
})
function editor() { return render(<CustomExtensionEditor projectId="project-a" initialKind="mcp" onClose={vi.fn()} onSaved={vi.fn()} />) }
function setJson(value: string) { fireEvent.change(screen.getByRole('textbox', { name: 'MCP JSON 配置' }), { target: { value } }) }

describe('MCP configuration methods', () => {
  it('saves and tests pasted JSON directly without validating hidden manual fields', async () => {
    const user = userEvent.setup()
    editor()
    expect(screen.getByRole('tab', { name: '粘贴 JSON' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('textbox', { name: '可执行命令' })).not.toBeInTheDocument()
    setJson(JSON.stringify({ mcpServers: { demo: { command: 'node', args: ['server.js'] } } }))
    await user.click(screen.getByRole('button', { name: '测试连接' }))
    await screen.findByText(/连接成功/)
    const tested = vi.mocked(configApi.testMcpServer).mock.calls[0][0]
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(extensionsApi.saveCustom).toHaveBeenCalledWith('project-a', expect.objectContaining({ kind: 'mcp', name: 'demo', description: '', mcp: tested }))
  })
  it('keeps independent drafts and clears feedback when switching modes', async () => {
    const user = userEvent.setup()
    editor()
    setJson('{broken')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('JSON 格式无效')
    await user.click(screen.getByRole('tab', { name: '手动填写' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: '名称' }), 'manual')
    await user.type(screen.getByRole('textbox', { name: '可执行命令' }), 'node')
    await user.click(screen.getByRole('button', { name: '测试连接' }))
    await screen.findByText(/连接成功/)
    await user.click(screen.getByRole('tab', { name: '粘贴 JSON' }))
    expect(screen.getByRole('textbox', { name: 'MCP JSON 配置' })).toHaveValue('{broken')
    expect(screen.queryByText(/连接成功/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: '手动填写' }))
    expect(screen.getByRole('textbox', { name: '可执行命令' })).toHaveValue('node')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(extensionsApi.saveCustom).toHaveBeenCalledWith('project-a', expect.objectContaining({ name: 'manual', mcp: expect.objectContaining({ command: 'node' }) }))
  })
  it('requires choosing one service from a multi-server configuration', async () => {
    const user = userEvent.setup()
    editor()
    setJson(JSON.stringify({ mcpServers: { one: { command: 'one' }, two: { command: 'two' } } }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('请选择一个 MCP 服务')
    expect(extensionsApi.saveCustom).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /要添加的服务/ }))
    await user.click(screen.getByRole('option', { name: 'two' }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(extensionsApi.saveCustom).toHaveBeenCalledWith('project-a', expect.objectContaining({ name: 'two', mcp: expect.objectContaining({ command: 'two' }) })))
  })
})
