import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, apiRequest, applyConnectivityFromResponse } from '../api/origin'
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

describe('applyConnectivityFromResponse', () => {
  beforeEach(() => {
    useApiConnectivityStore.setState({
      browserOnline: true,
      apiReachable: 'unknown',
      failureCount: 0,
      lastCheckedAt: null,
    })
  })

  it('marks success for ok and 4xx responses', () => {
    applyConnectivityFromResponse(new Response(null, { status: 200 }))
    expect(useApiConnectivityStore.getState().apiReachable).toBe('reachable')

    useApiConnectivityStore.setState({ apiReachable: 'unknown' })
    applyConnectivityFromResponse(new Response(null, { status: 404 }))
    expect(useApiConnectivityStore.getState().apiReachable).toBe('reachable')
  })

  it('marks failure for gateway errors so polling can stop', () => {
    applyConnectivityFromResponse(new Response(null, { status: 502 }))
    expect(useApiConnectivityStore.getState().apiReachable).toBe('unreachable')
  })

  it('marks failure for 500 (vite proxy style) then relies on health probe to recover', () => {
    applyConnectivityFromResponse(new Response('Error: connect ECONNREFUSED', { status: 500 }))
    expect(useApiConnectivityStore.getState().apiReachable).toBe('unreachable')
  })
})

describe('apiFetch gateway failure', () => {
  beforeEach(() => {
    useApiConnectivityStore.setState({
      browserOnline: true,
      apiReachable: 'unknown',
      failureCount: 0,
      lastCheckedAt: null,
    })
  })

  it('marks unreachable on 502 so subsequent requests short-circuit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad Gateway', { status: 502 })))

    const resp = await apiFetch('/api/agent-runtime/sessions')
    expect(resp.status).toBe(502)
    expect(useApiConnectivityStore.getState().apiReachable).toBe('unreachable')

    await expect(apiFetch('/api/agent-runtime/sessions')).rejects.toThrow('网络连接失败')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
