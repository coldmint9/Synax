import { describe, expect, it } from 'vitest'
import {
  extractPlanNodeTitleFromPrompt,
  extractUserGoalFromPrompt,
  resolveGoalTitleSource,
  resolveShortGoalTitle,
} from '../wiki-goal-title.js'

describe('wiki-goal-title', () => {
  it('uses short user input directly as title', () => {
    expect(resolveShortGoalTitle('修复登录')).toBe('修复登录')
    expect(resolveShortGoalTitle('你好世界')).toBe('你好世界')
    expect(resolveShortGoalTitle('1234567')).toBe('1234567')
    expect(resolveShortGoalTitle('帮我看看认证模块')).toBeNull()
    expect(resolveShortGoalTitle('12345678')).toBeNull()
  })

  it('extracts user goal from direct mode prompt', () => {
    const prompt = [
      'Respond in English.',
      '',
      '## User Goal',
      'Fix auth token refresh',
      '',
      '## Wiki Context',
      '- Document: Auth',
    ].join('\n')

    expect(extractUserGoalFromPrompt(prompt)).toBe('Fix auth token refresh')
  })

  it('extracts plan node title from plan_node prompt', () => {
    const prompt = [
      'You are a Goal Agent',
      '',
      '## Plan Node',
      '- **Title**: Add redirect',
      '- **Description**: Redirect unauthenticated users',
    ].join('\n')

    expect(extractPlanNodeTitleFromPrompt(prompt)).toBe('Add redirect')
  })

  it('prefers goalContent from session metadata', () => {
    const source = resolveGoalTitleSource({
      sessionMetadata: { goalContent: 'Ship dark mode toggle' },
      prompt: '## User Goal\nIgnored goal',
    })

    expect(source).toBe('Ship dark mode toggle')
  })

  it('prefers planNodeTitle from session metadata', () => {
    const source = resolveGoalTitleSource({
      sessionMetadata: { planNodeTitle: 'Setup database' },
      prompt: '- **Title**: Fallback title',
    })

    expect(source).toBe('Setup database')
  })

  it('falls back to prompt sections when metadata is missing', () => {
    expect(resolveGoalTitleSource({
      sessionMetadata: null,
      prompt: '## User Goal\nRefactor utils module\n\n## Instructions',
    })).toBe('Refactor utils module')

    expect(resolveGoalTitleSource({
      sessionMetadata: null,
      prompt: '## Plan Node\n- **Title**: Retry node\n- **Description**: Fix tests',
    })).toBe('Retry node')
  })
})
