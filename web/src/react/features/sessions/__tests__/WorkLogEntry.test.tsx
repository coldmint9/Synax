import { beforeEach, describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useShellStore } from '../../../state/shellStore'
import { WorkLogEntry, type WorkLogEntryData } from '../WorkLogEntry'
import type { InterleavedTurn } from '../buildInterleavedTurns'

function turn(stepNumber: number, content: string): InterleavedTurn {
  const stepId = `step-${stepNumber}`
  return {
    stepId,
    index: stepNumber,
    status: 'completed',
    duration: '3.0s',
    blocks: [
      { type: 'thinking', content },
      {
        type: 'tool_call',
        call: {
          id: `tool-${stepNumber}`,
          toolId: 'bash',
          inputSummary: 'ls',
          outputSummary: 'ok',
          status: 'completed',
          category: 'shell',
          duration: '10ms',
          mutability: 'read',
        },
      },
    ],
  }
}

const ENTRY: WorkLogEntryData = {
  id: 'work-log-step-1',
  kind: 'work_log',
  createdAt: '2026-01-01T00:01:00.000Z',
  label: 'Work log · 3 steps',
  turns: [
    turn(1, 'first reasoning'),
    turn(2, 'second reasoning'),
    turn(3, 'third reasoning'),
  ],
  stats: { stepCount: 3, toolCallCount: 3, thinkingChars: 50, elapsedMs: 90_000 },
}

describe('WorkLogEntry', () => {
  beforeEach(() => {
    useShellStore.setState(state => ({
      preferences: { ...state.preferences, locale: 'en' },
    }))
  })

  it('collapses a run into one row and keeps the folded turns unmounted', () => {
    const { container } = render(<WorkLogEntry entry={ENTRY} />)

    expect(container.textContent).toContain('Worked for 1m 30s')
    expect(container.textContent).toContain('3 steps')
    expect(container.textContent).toContain('3 calls')
    expect(container.textContent).toContain('1m 30s')
    expect(container.querySelector('[data-activity-body]')).toBeNull()
    expect(container.textContent).not.toContain('second reasoning')
  })

  it('mounts the folded turns only when expanded', async () => {
    const user = userEvent.setup()
    const view = render(<WorkLogEntry entry={ENTRY} />)

    // A collapsed round keeps the folded turns out of the DOM entirely.
    expect(view.container.textContent).not.toContain('bash')

    await user.click(view.getByRole('button'))

    // One scroll body: the log itself. The records of each folded turn now
    // mount as rows, still folded, so their reasoning text stays out of the DOM.
    expect(view.container.querySelectorAll('[data-activity-body]')).toHaveLength(1)
    expect(view.container.textContent).toContain('bash')
    expect(view.container.querySelectorAll('.bui-thinking').length).toBeGreaterThan(0)
    expect(view.container.textContent).not.toContain('second reasoning')
  })

  it('previews the newest record while collapsed', () => {
    // A fresh id keeps this case out of the expand state the previous tests left.
    const { container } = render(<WorkLogEntry entry={{ ...ENTRY, id: 'work-log-step-7' }} />)

    const preview = container.querySelector('.bui-activity-preview')
    expect(preview?.textContent).toBe('third reasoning')
    expect(container.textContent).not.toContain('first reasoning')
  })

  it('restores the expanded state after a lazy unmount', async () => {
    const user = userEvent.setup()
    // A fresh id keeps this case out of the expand state the previous test left.
    const entry = { ...ENTRY, id: 'work-log-step-42' }
    const first = render(<WorkLogEntry entry={entry} />)
    await user.click(first.getByRole('button'))
    first.unmount()

    const second = render(<WorkLogEntry entry={entry} />)
    expect(second.container.querySelector('[data-activity-body]')).not.toBeNull()
  })
})
