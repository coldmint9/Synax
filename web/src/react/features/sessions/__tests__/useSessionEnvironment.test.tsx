import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { agentRuntimeApi as api, type SessionEnvironment } from '../../../../lib/api/agentRuntime'
import { useSessionEnvironment } from '../useSessionEnvironment'

afterEach(() => vi.restoreAllMocks())
const environment = (sessionId: string) => ({ sessionId, branch: sessionId }) as SessionEnvironment

it('shares concurrent requests and restores cached snapshots without crossing session boundaries', async () => {
  let resolve!: (value: SessionEnvironment) => void
  const fetch = vi.spyOn(api, 'getSessionEnvironment').mockReturnValueOnce(new Promise(r => { resolve = r })).mockResolvedValue(environment('env-b'))
  const first = renderHook(({ id }) => useSessionEnvironment(id), { initialProps: { id: 'env-a' } })
  const second = renderHook(() => useSessionEnvironment('env-a'))
  expect(fetch).toHaveBeenCalledTimes(1)
  await act(async () => { resolve(environment('env-a')) })
  expect(first.result.current.environment?.sessionId).toBe('env-a')
  expect(second.result.current.environment?.sessionId).toBe('env-a')
  first.rerender({ id: 'env-b' })
  expect(first.result.current.environment).toBeNull()
  await waitFor(() => expect(first.result.current.environment?.sessionId).toBe('env-b'))
  fetch.mockRejectedValue(new Error('offline'))
  first.rerender({ id: 'env-a' })
  expect(first.result.current.environment?.sessionId).toBe('env-a')
  await waitFor(() => expect(first.result.current.loading).toBe(false))
  expect(first.result.current.environment?.sessionId).toBe('env-a')
})
