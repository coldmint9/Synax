import { beforeEach, describe, expect, it, vi } from 'vitest'

// A fresh module per test: the pool is module state and must not leak between
// cases.
let mock: { stream: ReturnType<typeof vi.fn> }
let client: typeof import('./sessionLiveClient')
let store: typeof import('../../shared/state/runtimeConnectionStore')

beforeEach(async () => {
  vi.resetModules()
  mock = { stream: vi.fn(() => vi.fn()) }
  vi.doMock('./sessionLive', () => ({ sessionLiveStream: mock.stream }))
  client = await import('./sessionLiveClient')
  store = await import('../../shared/state/runtimeConnectionStore')
})

const deliver = (call: number) => mock.stream.mock.calls[call][1] as (event: unknown) => void
const fail = (call: number) => mock.stream.mock.calls[call][2] as (event: unknown) => void
const closeOf = (call: number) => mock.stream.mock.results[call].value as unknown as ReturnType<typeof vi.fn>
const idle = (id: string) => store.useRuntimeConnectionStore.getState().sessions[id]

/**
 * The user watches one session but the app keeps streaming the others. Switching
 * away must not disconnect a running session; the pool only bounds how many
 * background streams are retained, and an evicted stream is `idle`, never broken.
 */
describe('session keep-alive pool', () => {
  it('keeps a running session subscribed after selection moves away', () => {
    // A background consumer (Dock, preview) also watches `a`, so the stream has
    // a reason to stay open once `a` stops being the pinned session.
    client.addSessionLiveListener('a', () => {})
    client.ensureSessionLiveSubscription('a', () => {})
    const previous = closeOf(0)
    client.ensureSessionLiveSubscription('b', () => {})
    // Session `a` lost its pin but kept its stream: it keeps streaming while
    // the user reads `b`.
    expect(client.retainedSessionLiveCount()).toBe(2)
    expect(previous).not.toHaveBeenCalled()
    expect(idle('a')).not.toBe('closed')
  })

  it('releases the previous pinned connection on an intentional leave', () => {
    client.ensureSessionLiveSubscription('a', () => {})
    const streams = mock.stream.mock.calls.length
    client.releaseSessionLiveSubscription()
    // Closing the panel is a deliberate leave: the stream is closed (once) and
    // no ticket is kept with nobody watching; the session reports `idle`
    // instead of "disconnected".
    expect(mock.stream).toHaveBeenCalledTimes(streams)
    expect(closeOf(0)).toHaveBeenCalled()
    expect(idle('a')).toBe('idle')
    expect(client.retainedSessionLiveCount()).toBe(0)
  })

  it('does not reconnect when another consumer watches the same session', () => {
    const onScreen = vi.fn()
    client.ensureSessionLiveSubscription('a', onScreen)
    const dock = vi.fn()
    const releaseDock = client.addSessionLiveListener('a', dock)
    expect(mock.stream).toHaveBeenCalledTimes(1)
    deliver(0)({ type: 'runtime_state', reset: true })
    expect(onScreen).toHaveBeenCalledTimes(1)
    expect(dock).toHaveBeenCalledTimes(1)
    releaseDock()
    client.releaseSessionLiveSubscription()
  })

  it('bounds the pool and evicts the least recently viewed session as idle', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) client.addSessionLiveListener(id, () => {})
    // Seven concurrent consumers (e.g. Dock bridges) never exceed the bound.
    expect(client.retainedSessionLiveCount()).toBe(5)
    expect(idle('a')).toBe('idle')
    expect(idle('b')).toBe('idle')
    for (const id of ['c', 'd', 'e', 'f', 'g']) expect(idle(id)).not.toBe('idle')
  })

  it('drops a terminal background session instead of holding its ticket', () => {
    client.addSessionLiveListener('done', () => {})
    expect(client.retainedSessionLiveCount()).toBe(1)
    client.retireSessionLiveSubscription('done')
    expect(idle('done')).toBe('idle')
    expect(client.retainedSessionLiveCount()).toBe(0)
  })

  it('keeps the pinned finished session so its transcript stays exact', () => {
    client.ensureSessionLiveSubscription('finished', () => {})
    client.retireSessionLiveSubscription('finished')
    expect(closeOf(0)).not.toHaveBeenCalled()
    expect(idle('finished')).not.toBe('idle')
    client.releaseSessionLiveSubscription()
  })

  it('reports a genuine stream failure as closed, not idle', () => {
    const release = client.addSessionLiveListener('flaky', () => {})
    fail(0)(new Event('error'))
    expect(idle('flaky')).toBe('closed')
    release()
  })
})
