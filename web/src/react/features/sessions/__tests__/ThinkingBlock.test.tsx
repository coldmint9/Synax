import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useShellStore } from '../../../state/shellStore'
import { ThinkingBlock } from '../ThinkingBlock'

/**
 * Regression guard for the transcript render cost: a collapsed reasoning row
 * must not keep its text in the DOM, otherwise a session with dozens of large
 * reasoning blocks pays for all of them on every render.
 */
describe('ThinkingBlock', () => {
  beforeEach(() => {
    useShellStore.setState(state => ({
      preferences: { ...state.preferences, locale: 'en' },
    }))
  })

  it('keeps the reasoning body out of the DOM until expanded', () => {
    const content = `reasoning-${'x'.repeat(20_000)}`
    const { container } = render(<ThinkingBlock content={content} />)

    expect(container.querySelector('[data-activity-body]')).toBeNull()
    // Only the short teaser stays in the DOM — never the 20k-character body.
    expect(container.textContent ?? '').toContain('reasoning-')
    expect((container.textContent ?? '').length).toBeLessThan(300)
  })

  it('mounts the body on expand and unmounts it again', async () => {
    const user = userEvent.setup()
    const { container } = render(<ThinkingBlock content="step one reasoning" />)
    const header = screen.getByRole('button')

    await user.click(header)
    expect(container.querySelector('[data-activity-body]')?.textContent).toContain('step one reasoning')

    await user.click(header)
    expect(container.querySelector('[data-activity-body]')).toBeNull()
  })

  it('reports the character count for a collapsed row', () => {
    render(<ThinkingBlock content={'x'.repeat(7_240)} />)
    expect(screen.getByText('7.2k chars')).toBeTruthy()
  })

  it('renders a streaming row expanded and scrollable', () => {
    const { container } = render(<ThinkingBlock content="live reasoning" isStreaming />)
    expect(container.querySelector('[data-activity-body]')?.textContent).toContain('live reasoning')
  })

  it('only renders the tail of an oversized body when expanded', async () => {
    const user = userEvent.setup()
    const { container } = render(<ThinkingBlock content={`${'a'.repeat(9_000)}TAILMARK`} />)

    await user.click(screen.getByRole('button'))
    const body = container.querySelector('[data-activity-body]')?.textContent ?? ''
    expect(body).toContain('TAILMARK')
    expect(body).toContain('Hidden')
  })
})
