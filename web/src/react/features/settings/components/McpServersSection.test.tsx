import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { McpServersSection } from './McpServersSection'
vi.mock('../../../../hooks/useLocale', () => ({ useLocale: () => ({ locale: 'en', t: (key: string) => key }) }))
vi.mock('../../../../lib/api/config', () => ({ configApi: { testMcpServer: vi.fn() } }))
describe('McpServersSection', () => {
  it('can re-enable a disabled service', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<McpServersSection servers={[{ id: 'docs', name: 'Docs', command: 'docs', enabled: false }]} onSave={onSave} />)
    await user.click(screen.getByRole('checkbox'))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith([{ id: 'docs', name: 'Docs', command: 'docs', enabled: true }]))
  })
  it('retains the editor and arguments containing commas after a failed save', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Save failed'))
    const user = userEvent.setup()
    render(<McpServersSection servers={[{ id: 'docs', name: 'Docs', command: 'docs', args: ['a,b'] }]} onSave={onSave} />)
    await user.click(screen.getByRole('button', { name: 'settingsMcpEdit' }))
    await user.click(screen.getByRole('button', { name: 'settingsMcpSave' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith([expect.objectContaining({ args: ['a,b'] })]))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Save failed')
  })
})
