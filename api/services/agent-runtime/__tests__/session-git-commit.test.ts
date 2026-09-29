import { describe, expect, it, vi } from 'vitest';

vi.mock('../../llm-runtime/gateway.js', () => ({ generateGatewayTextResult: vi.fn() }));

import { normalizeCommitMessage } from '../session-git-commit.js';

describe('normalizeCommitMessage', () => {
  it('keeps a single-line message as-is', () => {
    expect(normalizeCommitMessage('feat: add commit and push button')).toBe('feat: add commit and push button');
  });

  it('keeps a subject with its optional body after one blank line', () => {
    expect(normalizeCommitMessage('fix: guard empty commit\n\nDetails here')).toBe('fix: guard empty commit\n\nDetails here');
  });

  it('strips code fences and collapses extra blank lines', () => {
    expect(normalizeCommitMessage('```text\nfeat: add flow\n\n\n\nBody line\n```')).toBe('feat: add flow\n\nBody line');
  });

  it('strips quotes and a leading preamble', () => {
    expect(normalizeCommitMessage('"Commit message: chore: bump deps"')).toBe('chore: bump deps');
  });

  it('strips a markdown bullet marker', () => {
    expect(normalizeCommitMessage('- docs: explain push flow')).toBe('docs: explain push flow');
  });

  it('returns an empty string for blank input so the caller can fail loudly', () => {
    expect(normalizeCommitMessage('   \n  ')).toBe('');
  });

  it('caps the message length', () => {
    expect(normalizeCommitMessage('x'.repeat(400))).toHaveLength(200);
  });

  it('caps the whole subject-plus-body message at 2000 characters', () => {
    expect(normalizeCommitMessage(`feat: big\n\n${'y'.repeat(3000)}`)).toHaveLength(2000);
  });
});
