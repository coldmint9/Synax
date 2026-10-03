import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it } from 'vitest'
import { useNotificationStore } from '../state/notificationStore'
import { ToastContainer } from './ToastContainer'

beforeEach(() => useNotificationStore.setState({ notifications: [], unreadCount: 0 }))

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
