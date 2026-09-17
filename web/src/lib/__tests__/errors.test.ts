import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../appError'
import { handleError } from '../errors'
import { useNotificationStore } from '../../react/state/notificationStore'

beforeEach(() => {
  useNotificationStore.setState({ notifications: [], unreadCount: 0 })
  vi.restoreAllMocks()
})

describe('handleError notification routing', () => {
  it('logs system errors without notifying the user', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    handleError(new AppError('Internal server error', {
      level: 'system',
      code: 'INTERNAL_ERROR',
      statusCode: 500,
    }))

    expect(consoleError).toHaveBeenCalledWith(
      '[system]',
      'Internal server error',
      'INTERNAL_ERROR',
      500,
    )
    expect(useNotificationStore.getState().notifications).toHaveLength(0)
  })

  it('notifies the user about business errors', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    handleError(new AppError('Invalid input', {
      level: 'business',
      code: 'VALIDATION_FAILED',
      statusCode: 422,
    }))

    expect(useNotificationStore.getState().notifications).toHaveLength(1)
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      type: 'error',
      message: '输入参数有误',
      visible: true,
    })
  })
})
