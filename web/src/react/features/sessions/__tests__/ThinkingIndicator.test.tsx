import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { ThinkingIndicator } from '../ThinkingIndicator'

describe('ThinkingIndicator', () => {
  it('renders three staggered bouncing dots while a request is pending', () => {
    const { container } = render(<ThinkingIndicator />)

    const status = container.querySelector('[role="status"]')
    const dots = Array.from(container.querySelectorAll('[data-thinking-dot]'))

    expect(status?.getAttribute('aria-label')).toBeTruthy()
    expect(dots).toHaveLength(3)
    expect(dots.map(dot => dot.classList.contains('animate-thinking-bounce'))).toEqual([true, true, true])
    expect(dots.map(dot => (dot as HTMLElement).style.animationDelay)).toEqual(['', '200ms', '400ms'])
  })
})
