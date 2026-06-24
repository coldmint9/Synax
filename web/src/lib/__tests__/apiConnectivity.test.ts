import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useNotificationStore } from '../../react/state/notificationStore'
import {
  API_CONNECTIVITY_NOTIFICATION_ID,
  notifyConnectivityFailure,
  useApiConnectivityStore,
} from '../apiConnectivity'
import { handleError } from '../errors'
import { createOfflineError } from '../appError'

describe('notifyConnectivityFailure', () => {
  beforeEach(() => {
    useNotificationStore.setState({ notifications: [], unreadCount: 0 })
    useApiConnectivityStore.setState({
      browserOnline: true,
      apiReachable: 'unknown',
      failureCount: 0,
      lastCheckedAt: null,
    })
  })

  it('aggregates repeated connectivity failures into one notification', () => {
    notifyConnectivityFailure('网络连接失败，无法访问后端服务')
    notifyConnectivityFailure('网络连接失败，无法访问后端服务')
    notifyConnectivityFailure('网络连接失败，无法访问后端服务')

    const items = useNotificationStore.getState().notifications
    expect(items).toHaveLength(1)
    expect(items[0]?.id).toBe(API_CONNECTIVITY_NOTIFICATION_ID)
    expect(items[0]?.message).toContain('3 次请求失败')
  })

  it('does not create a new notification when bump is false', () => {
    notifyConnectivityFailure('网络连接失败，无法访问后端服务')
    notifyConnectivityFailure('网络连接失败，无法访问后端服务', false)

    const items = useNotificationStore.getState().notifications
    expect(items).toHaveLength(1)
    expect(items[0]?.aggregateCount).toBe(1)
  })
})

describe('handleError connectivity', () => {
  beforeEach(() => {
    useNotificationStore.setState({ notifications: [], unreadCount: 0 })
    useApiConnectivityStore.setState({
      browserOnline: true,
      apiReachable: 'unknown',
      failureCount: 0,
      lastCheckedAt: null,
    })
  })

  it('routes offline errors through aggregated connectivity notification', () => {
    handleError(createOfflineError())
    handleError(createOfflineError())

    const items = useNotificationStore.getState().notifications
    expect(items).toHaveLength(1)
    expect(items[0]?.id).toBe(API_CONNECTIVITY_NOTIFICATION_ID)
    expect(items[0]?.message).toContain('2 次请求失败')
  })

  it('aggregates fetch network TypeError failures', () => {
    handleError(new TypeError('Failed to fetch'))
    handleError(new TypeError('Failed to fetch'))

    const items = useNotificationStore.getState().notifications
    expect(items).toHaveLength(1)
    expect(items[0]?.message).toContain('2 次请求失败')
    expect(useApiConnectivityStore.getState().apiReachable).toBe('unreachable')
  })
})

describe('useApiConnectivityStore', () => {
  beforeEach(() => {
    useNotificationStore.setState({ notifications: [], unreadCount: 0 })
    useApiConnectivityStore.setState({
      browserOnline: true,
      apiReachable: 'unknown',
      failureCount: 0,
      lastCheckedAt: null,
    })
  })

  it('dismisses connectivity toast after recovery', () => {
    useApiConnectivityStore.setState({ apiReachable: 'unreachable' })
    notifyConnectivityFailure('offline')
    useApiConnectivityStore.getState().markSuccess()

    const toast = useNotificationStore.getState().notifications.find(
      n => n.id === API_CONNECTIVITY_NOTIFICATION_ID,
    )
    expect(toast?.visible).toBe(false)
  })

  it('blocks requests while unreachable', () => {
    useApiConnectivityStore.setState({ apiReachable: 'unreachable' })
    expect(useApiConnectivityStore.getState().shouldSkipRequest()).toBe(true)
  })
})
