import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { useNotificationStore } from '../state/notificationStore'
import { ToastContainer } from './ToastContainer'

beforeEach(() => useNotificationStore.setState({ notifications: [], unreadCount: 0 }))

it('renders the archive notice with inline View and Undo buttons and dismisses after undo', async () => {
  const undo = vi.fn()
  useNotificationStore.getState().push({
    type: 'success', layout: 'archive', message: 'Archived chat', duration: 8000,
    actions: [{ label: 'View', onClick: vi.fn() }, { label: 'Undo', variant: 'primary', onClick: undo }],
  })
  render(<ToastContainer />)
  expect(screen.getByRole('status')).toHaveTextContent('Archived chat')
  expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Undo' })).toHaveClass('bg-zinc-900', 'text-white')
  await userEvent.setup().click(screen.getByRole('button', { name: 'Undo' }))
  expect(undo).toHaveBeenCalledOnce()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

it('shows an animated translucent toast surface in both themes and retains dismissal', async () => {
  useNotificationStore.setState({
    notifications: [{
      id: 'notice', type: 'info', message: 'Use the embedded job’s controls to stop this session.',
      timestamp: Date.now(), read: false, visible: true,
    }],
    unreadCount: 1,
  })

  render(<ToastContainer />)
  const surface = screen.getByText('Use the embedded job’s controls to stop this session.').parentElement?.parentElement
  expect(surface).toHaveClass('bg-white/90', 'dark:bg-black/80', 'backdrop-blur-xl')
  expect(surface).toHaveClass('motion-safe:animate-toast-enter')
  expect(surface).toHaveClass('border-black/10', 'dark:border-white/15')

  await userEvent.setup().click(screen.getByRole('button', { name: '关闭通知' }))
  expect(screen.queryByText('Use the embedded job’s controls to stop this session.')).not.toBeInTheDocument()
})
