import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useTranscriptScroll } from '../useTranscriptScroll'

it('restores reading position across session switches and does not restore into a skeleton', () => {
  const element = document.createElement('div')
  element.appendChild(document.createElement('div'))
  Object.defineProperties(element, { scrollHeight: { value: 2000 }, clientHeight: { value: 500 } })
  const ref = { current: element }
  const onReading = vi.fn()
  const { rerender, unmount } = renderHook(({ id, ready }) => useTranscriptScroll(ref, id, onReading, ready), { initialProps: { id: 'scroll-a', ready: true } })
  expect(element.scrollTop).toBe(2000)
  act(() => {
    element.dispatchEvent(new Event('wheel'))
    element.scrollTop = 320
    element.dispatchEvent(new Event('scroll'))
  })
  rerender({ id: 'scroll-b', ready: false })
  element.scrollTop = 0
  rerender({ id: 'scroll-b', ready: true })
  expect(element.scrollTop).toBe(2000)
  rerender({ id: 'scroll-a', ready: true })
  expect(element.scrollTop).toBe(320)
  expect(onReading).toHaveBeenLastCalledWith(true)
  unmount()
})
