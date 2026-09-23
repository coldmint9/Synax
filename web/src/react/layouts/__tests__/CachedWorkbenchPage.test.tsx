import { fireEvent, render, screen } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { expect, it, vi } from 'vitest'
import { CachedWorkbenchPage, useWorkbenchPageActive } from '../CachedWorkbenchPage'
it('does no work before the first visit, pauses page work and retains the draft on hide', () => {
  const start = vi.fn(), stop = vi.fn()
  function Editor() {
    const active = useWorkbenchPageActive(), [draft, setDraft] = useState('')
    useEffect(() => { if (!active) return; start(); return stop }, [active])
    return <input aria-label="draft" value={draft} onChange={e => setDraft(e.target.value)} />
  }
  const view = render(<CachedWorkbenchPage active={false}><Editor /></CachedWorkbenchPage>)
  expect(start).not.toHaveBeenCalled(); expect(screen.queryByLabelText('draft')).toBeNull()
  view.rerender(<CachedWorkbenchPage active><Editor /></CachedWorkbenchPage>)
  fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'unsent draft' } })
  view.rerender(<CachedWorkbenchPage active={false}><Editor /></CachedWorkbenchPage>)
  expect(stop).toHaveBeenCalledOnce()
  view.rerender(<CachedWorkbenchPage active><Editor /></CachedWorkbenchPage>)
  expect(screen.getByLabelText('draft')).toHaveValue('unsent draft')
  expect(start).toHaveBeenCalledTimes(2)
})
