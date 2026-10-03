import { describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ stream: vi.fn() }))
vi.mock('./sessionLive', () => ({ sessionLiveStream: mock.stream }))
import { addSessionLiveListener } from './sessionLiveClient'

describe('shared stream snapshots', () => {
  it('joins concurrent listeners onto the live connection without reconnecting', () => {
    const close = vi.fn(); mock.stream.mockReturnValue(close)
    const a = vi.fn(), b = vi.fn()
    const releaseA = addSessionLiveListener('shared', a)
    expect(mock.stream).toHaveBeenCalledTimes(1)
    const deliver = mock.stream.mock.calls[0][1] as (event: unknown) => void
    // A second subscriber joins the healthy connection instead of tearing it down.
    const releaseB = addSessionLiveListener('shared', b)
    expect(mock.stream).toHaveBeenCalledTimes(1)
    deliver({ type: 'runtime_state', reset: true })
    expect(a).toHaveBeenCalledTimes(1); expect(b).toHaveBeenCalledTimes(1)
    releaseB(); releaseA()
    expect(close).toHaveBeenCalledTimes(1)
    expect(mock.stream).toHaveBeenCalledTimes(1)
  })

  it('opens a fresh connection for a listener arriving after the previous one failed', () => {
    const close = vi.fn(); mock.stream.mockReturnValue(close)
    mock.stream.mockClear()
    const a = vi.fn()
    const releaseA = addSessionLiveListener('retry', a)
    const deliver = mock.stream.mock.calls[0][1] as (event: unknown) => void
    const fail = mock.stream.mock.calls[0][2] as (event: unknown) => void
    // Terminal stream error drops the connection; the next listener reconnects.
    fail(new Event('error'))
    expect(a).not.toHaveBeenCalled()
    const b = vi.fn()
    const releaseB = addSessionLiveListener('retry', b)
    expect(mock.stream).toHaveBeenCalledTimes(2)
    const deliverB = mock.stream.mock.calls[1][1] as (event: unknown) => void
    deliverB({ type: 'runtime_state', reset: true })
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
    releaseA(); releaseB(); expect(close).toHaveBeenCalledTimes(2)
  })
})
