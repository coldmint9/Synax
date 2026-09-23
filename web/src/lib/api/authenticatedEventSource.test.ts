import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ObservationHandler } from './realtime/connection'
const mock = vi.hoisted(() => ({ subscribe: vi.fn(), release: vi.fn() }))
vi.mock('./realtime', () => ({ subscribeObservation: mock.subscribe }))
import { AuthenticatedEventSource } from './authenticatedEventSource'
import { useApiConnectivityStore } from '../apiConnectivity'
let handler: ObservationHandler
beforeEach(() => {
  mock.subscribe.mockImplementation((_path, listener) => { handler = listener; return mock.release })
  useApiConnectivityStore.setState({ browserOnline: true, apiReachable: 'reachable', recoveryVersion: 0 })
})
afterEach(() => vi.clearAllMocks())
it('preserves named SSE event data and cursors on the multiplexed transport', async () => {
  const source = new AuthenticatedEventSource('/api/agent-runtime/events/stream')
  const listener = vi.fn(); source.addEventListener('snapshot', listener)
  await Promise.resolve(); handler({ type: 'open' }); handler({ type: 'event', event: 'snapshot', data: '{"ok":true}', lastEventId: '42' })
  expect(source.readyState).toBe(AuthenticatedEventSource.OPEN)
  expect(listener.mock.calls[0][0]).toMatchObject({ data: '{"ok":true}', lastEventId: '42' })
  source.close(); expect(mock.release).toHaveBeenCalledOnce()
  handler({ type: 'event', event: 'snapshot', data: 'stale' }); expect(listener).toHaveBeenCalledTimes(1)
})
it('does not globally mark the API offline on a local recoverable stream failure', async () => {
  const source = new AuthenticatedEventSource('/api/agent-runtime/events/stream'); const error = vi.fn(); source.onerror = error
  await Promise.resolve(); handler({ type: 'connecting' })
  expect(source.readyState).toBe(AuthenticatedEventSource.CONNECTING)
  expect(useApiConnectivityStore.getState().apiReachable).toBe('reachable')
  expect(mock.release).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledOnce(); source.close()
})
it('closes only the affected observer for an authorization/not-found error', async () => {
  const source = new AuthenticatedEventSource('/api/agent-runtime/events/stream')
  await Promise.resolve(); handler({ type: 'error', status: 404, message: 'missing', retryable: false })
  expect(source.readyState).toBe(AuthenticatedEventSource.CLOSED); expect(mock.release).toHaveBeenCalledOnce()
  expect(useApiConnectivityStore.getState().apiReachable).toBe('reachable')
})
it('does not allocate a subscription if StrictMode cancels before its microtask', async () => {
  const source = new AuthenticatedEventSource('/api/agent-runtime/events/stream'); source.close(); await Promise.resolve()
  expect(mock.subscribe).not.toHaveBeenCalled()
})
it('rejects credential/observation forwarding to a different origin', async () => {
  const source = new AuthenticatedEventSource('https://evil.invalid/api/agent-runtime/events/stream'); await Promise.resolve()
  expect(source.readyState).toBe(AuthenticatedEventSource.CLOSED); expect(mock.subscribe).not.toHaveBeenCalled()
})
