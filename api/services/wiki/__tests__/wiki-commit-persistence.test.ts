import { describe, expect, it } from 'vitest';
import { findExistingDocId } from '../wiki-commit-persistence.js';
import type { WikiOutlineEntry } from '../tools/contracts.js';

describe('findExistingDocId', () => {
  const outline: WikiOutlineEntry[] = [
    { id: 'plan-root', docType: 'landscape', title: 'Overview', sortOrder: 0, targetFiles: [], keyQuestions: [] },
    {
      id: 'plan-child',
      docType: 'module',
      title: 'Auth Module',
      parentId: 'plan-root',
      sortOrder: 1,
      targetFiles: [],
      keyQuestions: [],
    },
  ];

  const planIdToDocId = new Map([
    ['plan-root', 'doc-root'],
    ['plan-child', 'doc-child'],
  ]);

  it('resolves root document by title and docType', () => {
    expect(findExistingDocId(
      { title: 'Overview', docType: 'landscape' },
      outline,
      planIdToDocId,
    )).toBe('doc-root');
  });

  it('resolves child document even when parentPlanId is set', () => {
    expect(findExistingDocId(
      { title: 'Auth Module', docType: 'module' },
      outline,
      planIdToDocId,
    )).toBe('doc-child');
  });

  it('returns null when outline entry is missing', () => {
    expect(findExistingDocId(
      { title: 'Missing', docType: 'module' },
      outline,
      planIdToDocId,
    )).toBeNull();
  });
});
