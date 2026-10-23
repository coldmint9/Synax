import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { useNotificationStore } from '../state/notificationStore'
import { ToastContainer } from './ToastContainer'

beforeEach(() => useNotificationStore.setState({ notifications: [], unreadCount: 0 }))

it('renders the archive notice with the normal toast surface and inline actions, and dismisses after undo', async () => {
  const undo = vi.fn()
  useNotificationStore.getState().push({
    type: 'success', layout: 'archive', message: 'Archived chat', duration: 8000,
    actions: [{ label: 'View', onClick: vi.fn() }, { label: 'Undo', variant: 'primary', onClick: undo }],
  })
  render(<ToastContainer />)
  const surface = screen.getByRole('status')
  expect(surface).toHaveTextContent('Archived chat')
  // 归档通知复用普通通知的容器、图标尺寸、排版与关闭按钮。
  expect(surface).toHaveClass(
    'flex', 'items-start', 'gap-2', 'rounded-xl', 'px-3', 'py-2',
    'bg-white/90', 'backdrop-blur-xl', 'dark:bg-black/80',
    'border-black/10', 'dark:border-white/15', 'motion-safe:animate-toast-enter',
  )
  expect(surface.querySelector('svg')).toHaveAttribute('width', '14')
  expect(surface.querySelector('.rounded-md svg')).toHaveAttribute('width', '12')
  expect(surface.parentElement?.parentElement?.parentElement).toHaveClass('w-[340px]')
  expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Undo' })).toHaveClass('text-[11px]', 'font-medium', 'text-success')
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

it('keeps the technical detail as secondary copy under the headline', () => {
  useNotificationStore.getState().push({
    type: 'error',
    message: '操作失败，请稍后重试',
    detail: 'Config API error 500: internal failure',
  })

  render(<ToastContainer />)
  expect(screen.getByText('操作失败，请稍后重试')).toHaveClass('line-clamp-3')
  expect(screen.getByText('Config API error 500: internal failure')).toHaveClass('line-clamp-2')
})
