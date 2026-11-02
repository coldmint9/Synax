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
  it('does not turn keyword matches into system instructions', () => {
    for (const [message, mode] of [['Explore where sessions are stored', 'chat'], ['Refactor the session store', 'chat'], ['Implement login endpoint', 'goal'], ['Implement a login form', 'plan']] as const)
      expect(buildSynaxIntentPromptSection({ message, mode, stepIndex: 1 })).toBeNull();
  });
});


describe('intent is not execution authorization', () => {
  it.each(['plan 模式真的有效吗？', 'How do I fix this bug?', '请调查会话列表的过滤机制'])('keeps %s in investigation', message => {
    expect(classifySynaxIntent(message)).toBe('explore');
  });
  it('retains classification as advisory data only', () => {
    expect(buildSynaxIntentPromptSection({ message: 'Implement a login form', mode: 'plan' })).toBeNull();
  });
});
