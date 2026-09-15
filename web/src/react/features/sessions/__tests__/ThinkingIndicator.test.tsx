import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { ThinkingIndicator } from '../ThinkingIndicator'

describe('ThinkingIndicator', () => {
  it('renders a live status label while a request is pending', () => {
    const { container } = render(<ThinkingIndicator />)

    expect(container.querySelector('[role="status"]')?.textContent).toBeTruthy()
    expect(container.querySelector('.bui-thinking')).toHaveAttribute('data-live', 'true')
  })
})
