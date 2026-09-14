import { describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ stream: vi.fn() }))
vi.mock('./sessionLive', () => ({ sessionLiveStream: mock.stream }))
import { addSessionLiveListener } from './sessionLiveClient'

describe('shared stream snapshots', () => {
  it('rehydrates a late listener and ignores events from the replaced connection', () => {
    const close = vi.fn(); mock.stream.mockReturnValue(close)
    const a = vi.fn(), b = vi.fn()
    const releaseA = addSessionLiveListener('shared', a)
    const old = mock.stream.mock.calls[0][1] as (event: unknown) => void
    const releaseB = addSessionLiveListener('shared', b)
    expect(mock.stream).toHaveBeenCalledTimes(2)
    old({ type: 'message_delta', stepId: 'old', delta: 'stale' })
    expect(a).not.toHaveBeenCalled(); expect(b).not.toHaveBeenCalled()
    const current = mock.stream.mock.calls[1][1] as (event: unknown) => void
    current({ type: 'runtime_state', reset: true })
    expect(a).toHaveBeenCalledTimes(1); expect(b).toHaveBeenCalledTimes(1)
    releaseB(); releaseA(); expect(close).toHaveBeenCalledTimes(2)
  })
})
