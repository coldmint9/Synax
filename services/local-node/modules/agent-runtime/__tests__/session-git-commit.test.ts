import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../infrastructure/llm-runtime/gateway.js', () => ({ generateGatewayTextResult: vi.fn() }));

import { normalizeCommitMessage, resolveConflictText } from '../session-git-commit.js';

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

describe('resolveConflictText', () => {
  it('resolves identical sides and preserves surrounding text', () => {
    const result = resolveConflictText(
      'before\n<<<<<<< ours\nshared\n=======\nshared\n>>>>>>> theirs\nafter\n',
    );
    expect(result).toEqual({
      found: true,
      resolved: true,
      content: 'before\nshared\nafter\n',
    });
  });

  it('uses the changed side when diff3 identifies an unchanged base', () => {
    const result = resolveConflictText(
      '<<<<<<< ours\nbase\n||||||| base\nbase\n=======\nsource\n>>>>>>> theirs\n',
    );
    expect(result.resolved).toBe(true);
    expect(result.content).toBe('source\n');
  });

  it('leaves competing edits unresolved', () => {
    const content = '<<<<<<< ours\nlocal\n=======\nremote\n>>>>>>> theirs\n';
    expect(resolveConflictText(content)).toEqual({
      found: true,
      resolved: false,
      content,
    });
  });

  it('does not treat ordinary text without markers as a conflict', () => {
    expect(resolveConflictText('plain text\n')).toEqual({
      found: false,
      resolved: false,
      content: 'plain text\n',
    });
  });

  it('does not discard an empty side that may be an intentional deletion', () => {
    const content = '<<<<<<< ours\n=======\nremote edit\n>>>>>>> theirs\n';
    expect(resolveConflictText(content)).toEqual({ found: true, resolved: false, content });
  });

  it('handles an empty diff3 base and retains CRLF', () => {
    const content = 'before\r\n<<<<<<< ours\r\n||||||| base\r\n=======\r\nnew\r\n>>>>>>> theirs\r\nafter\r\n';
    expect(resolveConflictText(content)).toEqual({ found: true, resolved: true, content: 'before\r\nnew\r\nafter\r\n' });
  });

  it('supports custom conflict-marker-size', () => {
    expect(resolveConflictText('<<<<<<<<< ours\nsame\n=========\nsame\n>>>>>>>>> theirs\n').content).toBe('same\n');
  });

  it.each([
    '<<<<<<< ours\nunfinished\n',
    '>>>>>>> orphan\n',
    '<<<<<<< ours\na\n<<<<<<< nested\na\n=======\na\n>>>>>>> theirs\n',
    '<<<<<<< ours\na\n=========\na\n>>>>>>> theirs\n',
  ])('rejects incomplete or malformed marker blocks', content => {
    expect(resolveConflictText(content)).toEqual({ found: true, resolved: false, content });
  });
});
