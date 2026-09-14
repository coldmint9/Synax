import { describe, expect, it } from 'vitest';
import {
  buildSynaxIntentPromptSection,
  classifySynaxIntent,
  isConversationalMessage,
} from '../synax-intent-hints.js';

describe('classifySynaxIntent', () => {
  it('classifies exploration intent', () => {
    expect(classifySynaxIntent('Explore the codebase and find where auth is handled')).toBe('explore');
    expect(classifySynaxIntent('调研一下登录模块在哪里实现的')).toBe('explore');
  });

  it('classifies coding intent', () => {
    expect(classifySynaxIntent('Implement user login endpoint')).toBe('coding');
    expect(classifySynaxIntent('修复这个 bug')).toBe('coding');
  });

  it('prefers coding over exploration when both match', () => {
    expect(classifySynaxIntent('Investigate the auth bug and fix it')).toBe('coding');
  });

  it('classifies review and plan intents', () => {
    expect(classifySynaxIntent('Please review this PR for regressions')).toBe('review');
    expect(classifySynaxIntent('Help me plan and break down this feature')).toBe('plan');
  });
});

describe('isConversationalMessage', () => {
  it('detects greetings and short non-task messages', () => {
    expect(isConversationalMessage('你好')).toBe(true);
    expect(isConversationalMessage('Hi there')).toBe(true);
    expect(isConversationalMessage('Implement login')).toBe(false);
  });
});

describe('buildSynaxIntentPromptSection', () => {
  it('keeps investigation read-only without mandating delegation', () => {
    const section = buildSynaxIntentPromptSection({
      message: 'Explore where sessions are stored',
      mode: 'chat',
      stepIndex: 1,
    });
    expect(section).toContain('Investigate and explain');
    expect(section).not.toContain('first and only tool');
    expect(section).not.toContain('subagent.delegate');
    expect(section).not.toContain('wiki.search_batch');
    expect(section).toContain('advisory');
  });

  it('injects coding discipline hints for coding intent', () => {
    const section = buildSynaxIntentPromptSection({
      message: 'Refactor the session store',
      mode: 'chat',
      stepIndex: 2,
    });
    expect(section).toContain('Implement the requested change within current authorization');
  });

  it('does not inject coding hints for goal mode without explicit coding verbs', () => {
    const section = buildSynaxIntentPromptSection({
      message: 'Improve session title handling',
      mode: 'goal',
      stepIndex: 1,
    });
    expect(section).toBeNull();
  });

  it('returns null for conversational goal-mode greetings', () => {
    expect(buildSynaxIntentPromptSection({
      message: '你好',
      mode: 'goal',
      stepIndex: 1,
    })).toBeNull();
  });

  it('injects coding hints for explicit implementation in goal mode', () => {
    const section = buildSynaxIntentPromptSection({
      message: 'Implement login endpoint',
      mode: 'goal',
      stepIndex: 1,
    });
    expect(section).toContain('Implement the requested change within current authorization');
  });

  it('skips coding hints for pure exploration in goal mode', () => {
    const section = buildSynaxIntentPromptSection({
      message: 'Explore how auth works before we change it',
      mode: 'goal',
      stepIndex: 1,
    });
    expect(section).toContain('Investigate and explain');
    expect(section).not.toContain('Implement the requested change');
  });
});


describe('intent is not execution authorization', () => {
  it.each(['plan 模式真的有效吗？', 'How do I fix this bug?', '请调查会话列表的过滤机制'])('keeps %s in investigation', message => {
    expect(classifySynaxIntent(message)).toBe('explore');
  });
  it('retains read-only planning even when implementation verbs are present', () => {
    const prompt = buildSynaxIntentPromptSection({ message: 'Implement a login form', mode: 'plan' });
    expect(prompt).toContain('without implementing');
    expect(prompt).not.toContain('Implement the requested change');
  });
});
