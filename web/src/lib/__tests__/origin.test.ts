import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiRequest } from '../api/origin'
import { useApiConnectivityStore } from '../apiConnectivity'
import { useNotificationStore } from '../../react/state/notificationStore'
import { API_CONNECTIVITY_NOTIFICATION_ID } from '../apiConnectivity'

describe('apiRequest offline short-circuit', () => {
  beforeEach(() => {
    useNotificationStore.setState({ notifications: [], unreadCount: 0 })
    useApiConnectivityStore.setState({
      browserOnline: true,
      apiReachable: 'unreachable',
      failureCount: 3,
      lastCheckedAt: Date.now(),
    })
    vi.stubGlobal('fetch', vi.fn())
  })

  it('skips fetch and does not spam notifications when already unreachable', async () => {
    await expect(apiRequest('/api/test')).rejects.toThrow('网络连接失败')
    await expect(apiRequest('/api/test')).rejects.toThrow('网络连接失败')

    expect(fetch).not.toHaveBeenCalled()
    const items = useNotificationStore.getState().notifications
    expect(items.filter(n => n.id === API_CONNECTIVITY_NOTIFICATION_ID)).toHaveLength(0)
  })

  it('allows silent offline short-circuit without notification', async () => {
    await expect(apiRequest('/api/test', { silent: true })).rejects.toThrow()
    expect(useNotificationStore.getState().notifications).toHaveLength(0)
  })
})
