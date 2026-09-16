import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listRemoteDirectories, type RemoteDirectoryListing } from '../../../lib/api/fs'
import { DirectoryPickerDialog } from './DirectoryPickerDialog'

vi.mock('../../../lib/api/fs', () => ({
  listRemoteDirectories: vi.fn(),
}))

function listing(overrides: Partial<RemoteDirectoryListing> = {}): RemoteDirectoryListing {
  return {
    path: '/home/dev',
    name: 'dev',
    parent: '/home',
    home: '/home/dev',
    shortcuts: [],
    entries: [
      { name: 'work', path: '/home/dev/work', hidden: false },
      { name: '.config', path: '/home/dev/.config', hidden: true },
    ],
    truncated: false,
    ...overrides,
  }
}

describe('DirectoryPickerDialog', () => {
  beforeEach(() => {
    vi.mocked(listRemoteDirectories).mockReset()
  })

  it('lists the initial directory on open and returns the chosen absolute path', async () => {
    vi.mocked(listRemoteDirectories).mockResolvedValue(listing())
    const onSelect = vi.fn()

    render(<DirectoryPickerDialog open initialPath="/home/dev" onClose={vi.fn()} onSelect={onSelect} />)

    expect(await screen.findByRole('button', { name: /work/ })).toBeInTheDocument()
    expect(listRemoteDirectories).toHaveBeenCalledWith('/home/dev', expect.objectContaining({ signal: expect.any(AbortSignal) }))

    fireEvent.click(screen.getByRole('button', { name: '选择此目录' }))
    expect(onSelect).toHaveBeenCalledWith({ path: '/home/dev', name: 'dev' })
  })

  it('descends into an entry and confirms the new path', async () => {
    vi.mocked(listRemoteDirectories)
      .mockResolvedValueOnce(listing())
      .mockResolvedValueOnce(listing({ path: '/home/dev/work', name: 'work', parent: '/home/dev', entries: [] }))
    const onSelect = vi.fn()

    render(<DirectoryPickerDialog open initialPath="/home/dev" onClose={vi.fn()} onSelect={onSelect} />)

    fireEvent.click(await screen.findByRole('button', { name: /work/ }))
    await waitFor(() => expect(listRemoteDirectories).toHaveBeenLastCalledWith('/home/dev/work', expect.anything()))

    fireEvent.click(screen.getByRole('button', { name: '选择此目录' }))
    expect(onSelect).toHaveBeenCalledWith({ path: '/home/dev/work', name: 'work' })
  })

  it('surfaces a listing failure without discarding the dialog', async () => {
    vi.mocked(listRemoteDirectories).mockRejectedValueOnce(new Error('Directory not found: /home/ghost'))

    render(<DirectoryPickerDialog open initialPath="/home/ghost" onClose={vi.fn()} onSelect={vi.fn()} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Directory not found: /home/ghost')
  })

  it('re-requests with hidden directories enabled', async () => {
    vi.mocked(listRemoteDirectories).mockResolvedValue(listing())

    render(<DirectoryPickerDialog open initialPath="/home/dev" onClose={vi.fn()} onSelect={vi.fn()} />)
    await screen.findByRole('button', { name: /work/ })

    fireEvent.click(screen.getByLabelText('显示隐藏目录'))

    await waitFor(() => expect(listRemoteDirectories).toHaveBeenLastCalledWith(
      '/home/dev',
      expect.objectContaining({ showHidden: true }),
    ))
  })

  it('closes on Escape', async () => {
    vi.mocked(listRemoteDirectories).mockResolvedValue(listing())
    const onClose = vi.fn()

    render(<DirectoryPickerDialog open initialPath="/home/dev" onClose={onClose} onSelect={vi.fn()} />)
    await screen.findByRole('button', { name: /work/ })

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
