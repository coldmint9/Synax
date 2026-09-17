import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCustomDraft } from './lib/providerPresets'
import { useProviderAutoSave } from './useProviderAutoSave'

const draft = { ...createCustomDraft([]), baseUrl: 'https://example.com', apiKey: 'test-key', model: 'original' }

describe('provider auto-save', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('debounces edits, ignores UI-only changes and does not save incomplete configuration', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const { rerender } = renderHook(({ value }) => useProviderAutoSave(value, save), { initialProps: { value: draft } })
    rerender({ value: { ...draft, modelOptions: ['candidate'], validationMessage: 'Connected' } })
    await act(() => vi.advanceTimersByTimeAsync(600))
    expect(save).not.toHaveBeenCalled()
    rerender({ value: { ...draft, model: 'first' } })
    await act(() => vi.advanceTimersByTimeAsync(300))
    rerender({ value: { ...draft, model: 'second' } })
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: 'second' }))
    rerender({ value: { ...draft, model: '' } })
    await act(() => vi.advanceTimersByTimeAsync(600))
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('serializes pending edits, including reverting to the initial value during a save', async () => {
    let resolveFirst!: () => void
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { resolveFirst = resolve }))
      .mockResolvedValue(undefined)
    const { result, rerender } = renderHook(({ value }) => useProviderAutoSave(value, save), { initialProps: { value: draft } })
    rerender({ value: { ...draft, model: 'first' } })
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(save).toHaveBeenCalledTimes(1)
    rerender({ value: { ...draft, model: 'second' } })
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(save).toHaveBeenCalledTimes(1)
    rerender({ value: draft })
    await act(async () => { resolveFirst() })
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][0].model).toBe('original')
    expect(result.current.saved).toBe(true)
  })

  it('cancels a scheduled save on unmount', async () => {
    const save = vi.fn()
    const { rerender, unmount } = renderHook(({ value }) => useProviderAutoSave(value, save), { initialProps: { value: draft } })
    rerender({ value: { ...draft, model: 'changed' } })
    unmount()
    await act(() => vi.advanceTimersByTimeAsync(600))
    expect(save).not.toHaveBeenCalled()
  })
})
