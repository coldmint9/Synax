import { describe, expect, it } from 'vitest'
import { buildGoalSessionPrompt } from '../wiki-goal-prompt.js'

describe('buildGoalSessionPrompt', () => {
  it('builds direct mode with wiki context', () => {
    const prompt = buildGoalSessionPrompt({
      mode: 'direct',
      content: 'Fix auth flow',
      documentTitle: 'Authentication',
      documentId: 'doc-1',
      anchorJson: { type: 'heading', heading: 'Login', quote: 'token refresh' },
      locale: 'en',
    })

    expect(prompt).toContain('## User Goal')
    expect(prompt).toContain('Fix auth flow')
    expect(prompt).toContain('## Wiki Context')
    expect(prompt).toContain('Authentication')
    expect(prompt).toContain('Keep wiki documentation aligned')
  })

  it('builds plan_node mode without wiki update instruction', () => {
    const prompt = buildGoalSessionPrompt({
      mode: 'plan_node',
      content: 'Implement login redirect',
      node: {
        title: 'Add redirect',
        description: 'Redirect unauthenticated users to login',
        expectedFiles: ['src/auth.ts'],
        dependsOn: ['Setup'],
      },
      linkedGoals: [{
        id: 'g1',
        projectId: 'p1',
        scope: 'document',
        documentId: 'doc-1',
        content: 'Fix auth',
        anchorJson: null,
        status: 'planned',
        planNodeId: null,
        lastSessionId: null,
        createdAt: 't',
        updatedAt: 't',
        resolvedAt: null,
      }],
      completedNodes: [{ title: 'Setup', summary: 'Added config' }],
      locale: 'en',
    })

    expect(prompt).toContain('## Plan Node')
    expect(prompt).toContain('Add redirect')
    expect(prompt).toContain('## Linked Goals')
    expect(prompt).toContain('[g1]')
    expect(prompt).toContain('## Completed Dependencies')
    expect(prompt).toContain('Setup: Added config')
    expect(prompt).toContain('src/auth.ts')
    expect(prompt).toContain('Do not update wiki documentation')
    expect(prompt).toContain('You may use shell')
    expect(prompt).not.toContain('Keep wiki documentation aligned')
  })

  it('includes redo feedback in plan_node mode', () => {
    const prompt = buildGoalSessionPrompt({
      mode: 'plan_node',
      content: 'Retry node',
      node: {
        title: 'Retry',
        description: 'Fix tests',
        expectedFiles: [],
        dependsOn: [],
      },
      redoFeedback: 'Tests still failing on edge case',
      locale: 'en',
    })

    expect(prompt).toContain('## Redo Feedback')
    expect(prompt).toContain('Tests still failing on edge case')
  })
})
