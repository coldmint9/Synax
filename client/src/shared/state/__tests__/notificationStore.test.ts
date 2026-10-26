import { beforeEach, describe, expect, it } from 'vitest'
import { useNotificationStore } from '../notificationStore'

function state() {
  return useNotificationStore.getState()
}

beforeEach(() => {
  useNotificationStore.setState({ notifications: [], unreadCount: 0 })
})

describe('notificationStore push semantics', () => {
  it('does not re-surface a dismissed notification for the same id', () => {
    state().push({ id: 'perm-1', type: 'warning', message: '会话等待审批', duration: 0 })
    state().dismiss('perm-1')

    state().push({ id: 'perm-1', type: 'warning', message: '会话等待审批', duration: 0 })
    expect(state().notifications).toHaveLength(1)
    expect(state().notifications[0].visible).toBe(false)
  })

  it('re-surfaces the same id when resurface is requested', () => {
    state().push({ id: 'perm-1', type: 'warning', message: '会话等待审批', duration: 0 })
    state().dismiss('perm-1')

    state().push({
      id: 'perm-1',
      type: 'warning',
      message: '会话等待审批',
      duration: 0,
      resurface: true,
    })

    expect(state().notifications).toHaveLength(1)
    expect(state().notifications[0].visible).toBe(true)
    expect(state().notifications[0].read).toBe(false)
  })

  it('keeps silent pushes in the notification centre only', () => {
    state().push({ type: 'error', message: '仅记录', silent: true })
    expect(state().notifications).toHaveLength(1)
    expect(state().notifications[0].visible).toBe(false)
  })
})

describe('notificationStore aggregation copy', () => {
  it('renders repeat counts as (×N)', () => {
    state().pushAggregated({ id: 'save', type: 'error', message: '保存失败', duration: 0 })
    state().pushAggregated({ id: 'save', type: 'error', message: '保存失败', duration: 0 })
    state().pushAggregated({ id: 'save', type: 'error', message: '保存失败', duration: 0 })

    expect(state().notifications[0].message).toBe('保存失败 (×3)')
    expect(state().notifications[0].aggregateCount).toBe(3)
  })

  it('strips a previous count before applying a new one', () => {
    state().pushAggregated({ id: 'save', type: 'error', message: '保存失败 (×2)', duration: 0 })
    expect(state().notifications[0].message).toBe('保存失败')
    state().pushAggregated({ id: 'save', type: 'error', message: '保存失败 (×2)', duration: 0 })
    expect(state().notifications[0].message).toBe('保存失败 (×2)')
  })

  it('carries the technical detail through aggregation', () => {
    state().pushAggregated({
      id: 'save',
      type: 'error',
      message: '保存失败',
      detail: 'HTTP 500',
      duration: 0,
    })
    expect(state().notifications[0].detail).toBe('HTTP 500')
  })
})
