import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { ThinkingIndicator } from '../ThinkingIndicator'

describe('ThinkingIndicator', () => {
  it('renders only the animated dots while a request is pending', () => {
    const { container } = render(<ThinkingIndicator />)

    expect(container.textContent).toBe('')
    expect(container.querySelectorAll('.animate-thinking-bounce')).toHaveLength(3)
  })
})
