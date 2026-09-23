import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SharedObservationHub } from '../shared-hub'
import type { ObservationConnection } from '../connection'
class Port {
  onmessage: ((event: MessageEvent) => void) | null = null
  sent: any[] = []
  postMessage = (message: unknown) => this.sent.push(message)
  start = vi.fn()
  receive(message: unknown) { this.onmessage?.({ data: message } as MessageEvent) }
}
let hub: SharedObservationHub, now: number, releases: ReturnType<typeof vi.fn>[], connection: { subscribe: ReturnType<typeof vi.fn>; wake: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }, factory: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.useFakeTimers(); now = 0; releases = []
  connection = { subscribe: vi.fn(() => { const release = vi.fn(); releases.push(release); return release }), wake: vi.fn(), dispose: vi.fn() }
  factory = vi.fn(() => connection as unknown as ObservationConnection)
  hub = new SharedObservationHub(factory, () => now)
})
afterEach(() => { hub.dispose(); vi.useRealTimers() })
const sync = (port: Port, id = 'one') => port.receive({ type: 'sync', origin: 'http://localhost:5173', subscriptions: [{ id, path: '/api/agent-runtime/sessions/s/stream', cursor: '7' }] })

it('shares one physical connection across four tabs, but gives late observers their own snapshots', () => {
  const ports = Array.from({ length: 4 }, () => new Port())
  for (const port of ports) { hub.attach(port); sync(port) }
  expect(factory).toHaveBeenCalledTimes(1); expect(connection.subscribe).toHaveBeenCalledTimes(4)
  const keys = connection.subscribe.mock.calls.map(([key]) => key)
  expect(new Set(keys).size).toBe(4)
  ports[0].receive({ type: 'disconnect' })
  expect(releases[0]).toHaveBeenCalledOnce(); expect(releases.slice(1).every(release => release.mock.calls.length === 0)).toBe(true)
})
it('keeps periodic leases from recreating healthy observations', () => {
  const port = new Port(); hub.attach(port); sync(port)
  for (let i = 0; i < 20; i++) sync(port)
  expect(connection.subscribe).toHaveBeenCalledTimes(1); expect(releases[0]).not.toHaveBeenCalled()
})
it('releases a frozen or closed tab and restores it from its cursor when it returns', () => {
  const stale = new Port(), active = new Port(); hub.attach(stale); hub.attach(active); sync(stale); sync(active)
  now = 50_000; sync(active); now = 80_000; hub.sweep()
  expect(releases[0]).toHaveBeenCalledOnce(); expect(releases[1]).not.toHaveBeenCalled()
  sync(stale)
  expect(connection.subscribe).toHaveBeenCalledTimes(3)
  expect(connection.subscribe.mock.calls[2][3]).toBe('7')
})
it('requests grants only through a live same-origin tab and never shares credentials with other observers', async () => {
  let requestTicket!: () => Promise<string>
  factory.mockImplementation((_origin, ticket) => { requestTicket = ticket; return connection as unknown as ObservationConnection })
  const a = new Port(), b = new Port(); hub.attach(a); hub.attach(b); sync(a); sync(b)
  const pending = requestTicket(); const request = a.sent.find(frame => frame.type === 'ticket-request')
  b.receive({ type: 'ticket', id: request.id, ticket: 'wrong-port' })
  a.receive({ type: 'ticket', id: request.id, ticket: 'grant' })
  expect(await pending).toBe('grant')
  expect(b.sent.some(frame => frame.ticket)).toBe(false)
})
it('does not attach a second backend to the same worker', () => {
  const a = new Port(), b = new Port(); hub.attach(a); sync(a); hub.attach(b)
  b.receive({ type: 'sync', origin: 'http://localhost:3211', subscriptions: [] })
  expect(b.sent).toContainEqual({ type: 'unavailable' }); expect(factory).toHaveBeenCalledTimes(1)
})
