import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../appError'
import { handleError } from '../errors'
import { useNotificationStore } from '../../state/notificationStore'

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

  it('falls back to a readable message when the server only sends a status code', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    handleError(new AppError('conflict: revision mismatch', {
      level: 'business',
      statusCode: 409,
    }))

    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      message: '当前状态与操作冲突，请刷新后重试',
      detail: 'conflict: revision mismatch',
    })
  })

  it('keeps technical payloads out of the headline', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    handleError(new AppError('Config API error 500: upstream exploded', {
      level: 'business',
    }))

    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      message: '操作失败，请稍后重试',
      detail: 'Config API error 500: upstream exploded',
    })
  })
})
