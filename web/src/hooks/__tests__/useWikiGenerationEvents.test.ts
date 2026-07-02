import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskNotificationEventType } from '../../lib/api/eventTypes'
import { useWikiGenerationEvents } from '../useWikiGenerationEvents'

type Subscription = {
  events?: Partial<Record<string, (e: MessageEvent) => void>>
  onConnect?: () => void
}

const subscriptions: Subscription[] = []

vi.mock('../../lib/api/taskNotificationBus', () => ({
  subscribe: (_projectId: string, sub: Subscription) => {
    subscriptions.push(sub)
    return () => {
      const idx = subscriptions.indexOf(sub)
      if (idx >= 0) subscriptions.splice(idx, 1)
    }
  },
}))

function latestSub(): Subscription {
  const sub = subscriptions[subscriptions.length - 1]
  if (!sub) throw new Error('No subscription registered')
  return sub
}

function emit(type: string, data: Record<string, unknown>) {
  const handler = latestSub().events?.[type]
  handler?.({ data: JSON.stringify(data) } as MessageEvent)
}

beforeEach(() => {
  vi.useFakeTimers()
  subscriptions.length = 0
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('useWikiGenerationEvents', () => {
  it('resets inactivity timer on task_progress', () => {
    const onFailed = vi.fn()
    const { result } = renderHook(() =>
      useWikiGenerationEvents({ projectId: 'p1', timeoutMs: 5_000, onFailed }),
    )

    act(() => {
      result.current.start('snap-1')
    })

    act(() => {
      vi.advanceTimersByTime(4_000)
    })

    act(() => {
      emit(TaskNotificationEventType.TaskProgress, {
        taskKind: 'wiki_generate',
        meta: { snapshotId: 'snap-1', snapshotStatus: 'refreshing' },
      })
    })

    act(() => {
      vi.advanceTimersByTime(4_000)
    })

    expect(result.current.active).toBe(true)
    expect(result.current.phase).toBe('refreshing')
    expect(onFailed).not.toHaveBeenCalled()
  })

  it('marks stale instead of failed on inactivity timeout', () => {
    const onFailed = vi.fn()
    const onStale = vi.fn()
    const { result } = renderHook(() =>
      useWikiGenerationEvents({ projectId: 'p1', timeoutMs: 1_000, onFailed, onStale }),
    )

    act(() => {
      result.current.start('snap-1', 'writing')
    })

    act(() => {
      vi.advanceTimersByTime(1_100)
    })

    expect(result.current.active).toBe(false)
    expect(result.current.stale).toBe(true)
    expect(result.current.phase).toBeNull()
    expect(result.current.error).toBeNull()
    expect(onStale).toHaveBeenCalled()
    expect(onFailed).toHaveBeenCalled()
  })

  it('uses longer default timeout for writing phase', async () => {
    const { wikiGenTimeoutForPhase } = await import('../../lib/constants/wikiGeneration')
    expect(wikiGenTimeoutForPhase('writing')).toBeGreaterThan(wikiGenTimeoutForPhase('refreshing'))
  })

  it('deactivates tracking when outline_ready is reached', () => {
    const { result } = renderHook(() =>
      useWikiGenerationEvents({ projectId: 'p1', timeoutMs: 5_000 }),
    )

    act(() => {
      result.current.start('snap-1', 'refreshing')
    })

    act(() => {
      emit(TaskNotificationEventType.TaskProgress, {
        taskKind: 'wiki_generate',
        meta: { snapshotId: 'snap-1', snapshotStatus: 'outline_ready' },
      })
    })

    expect(result.current.active).toBe(false)
    expect(result.current.phase).toBe('outline_ready')
  })
})
