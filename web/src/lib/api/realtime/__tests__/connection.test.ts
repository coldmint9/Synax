import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ObservationConnection } from '../connection'

class Socket {
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  frames: any[] = []
  send = (value: string) => this.frames.push(JSON.parse(value))
  close = vi.fn(() => { this.readyState = 3; this.onclose?.() })
  open() { this.readyState = 1; this.onopen?.(); this.frame({ type: 'ready', protocol: 1 }) }
  frame(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
}
let connection: ObservationConnection, sockets: Socket[], tickets: ReturnType<typeof vi.fn>, urls: string[]
beforeEach(() => {
  vi.useFakeTimers(); sockets = []; urls = []
  tickets = vi.fn(async () => 'one-time-grant')
  connection = new ObservationConnection({ socketUrl: 'ws://localhost:5173/api/realtime/socket', ticket: tickets, random: () => .5,
    socket: url => { urls.push(url); const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket } })
})
afterEach(() => { connection.dispose(); vi.useRealTimers() })
const flush = () => vi.advanceTimersByTimeAsync(0)

it('uses one authenticated socket for concurrent observations and no URL credentials', async () => {
  for (let i = 0; i < 4; i++) connection.subscribe(String(i), '/api/context/sync?projectId=p', vi.fn())
  await flush(); expect(tickets).toHaveBeenCalledTimes(1); expect(sockets).toHaveLength(1)
  sockets[0].open()
  expect(urls).toEqual(['ws://localhost:5173/api/realtime/socket'])
  expect(sockets[0].frames[0]).toEqual({ type: 'attach', ticket: 'one-time-grant' })
  expect(sockets[0].frames.filter(f => f.type === 'subscribe')).toHaveLength(4)
})
it('preserves cursors across service restart and ignores messages from the old generation', async () => {
  const handler = vi.fn(); connection.subscribe('s', '/api/agent-runtime/sessions/s/stream', handler)
  await flush(); const old = sockets[0]; old.open()
  old.frame({ type: 'event', id: 's', event: 'chunk', data: 'before', lastEventId: '42' })
  old.close(); await vi.advanceTimersByTimeAsync(1000)
  sockets[1].open()
  expect(sockets[1].frames.at(-1)).toMatchObject({ type: 'subscribe', cursor: '42' })
  old.frame({ type: 'event', id: 's', event: 'chunk', data: 'stale', lastEventId: '43' })
  sockets[1].frame({ type: 'event', id: 's', event: 'snapshot', data: 'current', lastEventId: '44' })
  expect(handler.mock.calls.filter(([n]) => n.type === 'event').map(([n]) => n.data)).toEqual(['before', 'current'])
})
it('does not recreate healthy sockets on repeated focus/wake', async () => {
  connection.subscribe('s', '/api/agent-runtime/events/stream', vi.fn())
  await flush(); sockets[0].open()
  for (let i = 0; i < 20; i++) connection.wake()
  await flush(); expect(sockets).toHaveLength(1); expect(tickets).toHaveBeenCalledTimes(1)
  expect(sockets[0].frames.filter(f => f.type === 'subscribe')).toHaveLength(1)
})
it('replaces a genuinely stale connection, not a healthy one', async () => {
  connection.subscribe('s', '/api/agent-runtime/events/stream', vi.fn())
  await flush(); sockets[0].open()
  vi.setSystemTime(Date.now() + 80_000); connection.wake(); await flush()
  expect(sockets[0].close).toHaveBeenCalled(); expect(sockets).toHaveLength(2)
})
it('unsubscribes one observer without interrupting others, then closes an idle transport', async () => {
  const one = connection.subscribe('one', '/api/agent-runtime/events/stream', vi.fn())
  const two = connection.subscribe('two', '/api/agent-runtime/events/stream', vi.fn())
  await flush(); sockets[0].open(); one()
  expect(sockets[0].frames.at(-1)).toEqual({ type: 'unsubscribe', id: 'one' })
  await vi.advanceTimersByTimeAsync(1000); expect(sockets[0].close).not.toHaveBeenCalled()
  two(); await vi.advanceTimersByTimeAsync(100); expect(sockets[0].close).toHaveBeenCalledTimes(1)
})
it('isolates per-subscription errors and retries just the failed observation', async () => {
  const one = vi.fn(), two = vi.fn()
  connection.subscribe('one', '/api/agent-runtime/events/stream', one)
  connection.subscribe('two', '/api/agent-runtime/events/stream', two)
  await flush(); sockets[0].open()
  sockets[0].frame({ type: 'error', id: 'one', status: 503, retryable: true })
  expect(one).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', status: 503 }))
  expect(two).not.toHaveBeenCalled(); expect(sockets[0].close).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  expect(sockets[0].frames.filter(f => f.type === 'subscribe' && f.id === 'one')).toHaveLength(2)
  expect(sockets[0].frames.filter(f => f.type === 'subscribe' && f.id === 'two')).toHaveLength(1)
})
it('does not connect after cancellation during ticket acquisition', async () => {
  let resolve!: (ticket: string) => void
  tickets.mockImplementationOnce(() => new Promise<string>(r => { resolve = r }))
  const release = connection.subscribe('s', '/api/agent-runtime/events/stream', vi.fn())
  release(); await vi.advanceTimersByTimeAsync(100); resolve('late'); await flush()
  expect(sockets).toHaveLength(0)
})
it('reports permission failures as terminal without an infinite retry loop', async () => {
  tickets.mockRejectedValue(Object.assign(new Error('Denied'), { status: 403 }))
  const handler = vi.fn(); connection.subscribe('s', '/api/agent-runtime/events/stream', handler)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(tickets).toHaveBeenCalledTimes(1)
  expect(handler).toHaveBeenCalledWith(expect.objectContaining({ status: 403, retryable: false }))
})
