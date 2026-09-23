import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const events = vi.hoisted(() => ({ sources: [] as any[] }))
vi.mock('./authenticatedEventSource', () => ({ AuthenticatedEventSource: class {
  static CLOSED = 2
  readyState = 1
  onmessage: any
  onerror: any
  close = vi.fn(() => { this.readyState = 2 })
  constructor(readonly url: string) { events.sources.push(this) }
} }))
import { agentRuntimeApi } from './agentRuntime'
import { useApiConnectivityStore } from '../apiConnectivity'
beforeEach(() => {
  events.sources.length = 0
  useApiConnectivityStore.setState({ apiReachable: 'reachable' })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ run: { id: 'run-1' }, reused: false }), { headers: { 'Content-Type': 'application/json' } })))
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
it.each(['turn', 'continue'] as const)('submits %s once and observes over the shared transport', async mode => {
  const chunk = vi.fn()
  const pending = (mode === 'turn' ? agentRuntimeApi.streamTurn : agentRuntimeApi.resumeStream)('session-1', { message: 'hello' }, chunk)
  await vi.waitFor(() => expect(events.sources).toHaveLength(1))
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch).toHaveBeenCalledWith('/api/agent-runtime/sessions/session-1/runs', expect.objectContaining({ method: 'POST', body: expect.any(String) }))
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toMatchObject({ mode, requestId: expect.any(String), message: 'hello' })
  const source = events.sources[0]
  expect(source.url).toBe('/api/agent-runtime/sessions/session-1/runs/run-1/stream')
  source.onmessage({ data: '{"type":"message_delta","delta":"text"}', lastEventId: '42' })
  source.onmessage({ data: '{"type":"message_delta","delta":"text"}', lastEventId: '42' })
  source.onmessage({ data: '[DONE]', lastEventId: '42' })
  await pending
  expect(chunk).toHaveBeenCalledTimes(1)
  expect(source.close).toHaveBeenCalledOnce()
})
