import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '../appError'
import { handleError } from '../errors'
import {
  isRuntimeResourceGone,
  markRuntimeResourcePendingRemoval,
  markRuntimeResourcesRemoved,
  resetRuntimeResourceRegistryForTests,
} from '../runtimeResourceRegistry'
import { useNotificationStore } from '../../react/state/notificationStore'

function missingResource(id: string): AppError {
  return new AppError(`Agent runtime resource not found: ${id}`, {
    level: 'business',
    code: 'NOT_FOUND',
    statusCode: 404,
  })
}

beforeEach(() => {
  resetRuntimeResourceRegistryForTests()
  useNotificationStore.setState({ notifications: [], unreadCount: 0 })
})

afterEach(() => {
  resetRuntimeResourceRegistryForTests()
})

describe('runtime resource registry', () => {
  it('tracks pending removals until the delete is confirmed', () => {
    markRuntimeResourcePendingRemoval('ars_pending')
    expect(isRuntimeResourceGone('ars_pending')).toBe(true)

    markRuntimeResourcesRemoved(['ars_pending'])
    expect(isRuntimeResourceGone('ars_pending')).toBe(true)
  })

  it('does not report unknown ids as removed', () => {
    expect(isRuntimeResourceGone('ars_unknown')).toBe(false)
  })
})

describe('handleError for a session the user deleted', () => {
  it('stays silent when the missing resource was removed on purpose', () => {
    markRuntimeResourcesRemoved(['ars_deleted'])

    handleError(missingResource('ars_deleted'))

    expect(useNotificationStore.getState().notifications).toHaveLength(0)
  })

  it('stays silent while that session deletion is still in flight', () => {
    markRuntimeResourcePendingRemoval('ars_inflight')

    handleError(missingResource('ars_inflight'))

    expect(useNotificationStore.getState().notifications).toHaveLength(0)
  })

  it('still reports a missing resource the user never deleted', () => {
    handleError(missingResource('ars_untouched'))

    const notifications = useNotificationStore.getState().notifications
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.message).toContain('ars_untouched')
  })
})
