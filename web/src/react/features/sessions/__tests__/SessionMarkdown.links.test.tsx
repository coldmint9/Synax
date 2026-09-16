import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SessionMarkdown } from '../SessionMarkdown'
import { TranscriptSessionProvider } from '../SessionTranscriptContext'
import { useSessionWorkspaceStore } from '../sessionWorkspaceStore'

function renderMarkdown(content: string, sessionId: string | null = 'session-1') {
  return render(
    <TranscriptSessionProvider sessionId={sessionId}>
      <SessionMarkdown content={content} />
    </TranscriptSessionProvider>,
  )
}

function activeTabs(sessionId: string) {
  const state = useSessionWorkspaceStore.getState().sessions[sessionId]
  return state?.tabs ?? []
}

describe('SessionMarkdown file links', () => {
  beforeEach(() => {
    useSessionWorkspaceStore.setState({ sessions: {} })
  })

  afterEach(cleanup)

  it('opens the file viewer for a workspace path instead of navigating away', () => {
    renderMarkdown('见 [web/src/index.css](web/src/index.css)。')

    const link = screen.getByRole('link', { name: 'web/src/index.css' })
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    fireEvent(link, event)

    expect(event.defaultPrevented).toBe(true)
    expect(activeTabs('session-1')).toEqual([
      expect.objectContaining({ kind: 'file', path: 'web/src/index.css', line: null }),
    ])
  })

  it('carries a line anchor from the link into the opened tab', () => {
    renderMarkdown('[a.ts](src/a.ts#L42)')

    fireEvent.click(screen.getByRole('link', { name: 'a.ts' }))

    expect(activeTabs('session-1')).toEqual([
      expect.objectContaining({ kind: 'file', path: 'src/a.ts', line: 42 }),
    ])
  })

  it('leaves ordinary URLs on their default anchor behaviour', () => {
    renderMarkdown('[docs](https://example.com/guide)')

    const link = screen.getByRole('link', { name: 'docs' })
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    fireEvent(link, event)

    expect(event.defaultPrevented).toBe(false)
    expect(link.getAttribute('href')).toBe('https://example.com/guide')
    expect(activeTabs('session-1')).toEqual([])
  })

  it('renders a file link without opening anything when there is no session scope', () => {
    renderMarkdown('[a.ts](src/a.ts)', null)

    const link = screen.getByRole('link', { name: 'a.ts' })
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    fireEvent(link, event)

    expect(event.defaultPrevented).toBe(false)
    expect(useSessionWorkspaceStore.getState().sessions).toEqual({})
  })
})
