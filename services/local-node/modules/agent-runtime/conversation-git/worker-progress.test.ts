import { expect, it } from 'vitest';
import { mergeProgressIdentity } from './worker-progress.js';

it('does not count changed receipts or object key order as progress', () => {
  const first = mergeProgressIdentity('git.merge.worker.inspect', {}, { mr: { status: 'ready', version: 1 }, execution: { revision: 1 }, taskRevision: 1 });
  const second = mergeProgressIdentity('git.merge.worker.inspect', {}, { taskRevision: 2, execution: { revision: 2 }, mr: { version: 2, status: 'ready' } });
  expect(second).toBe(first);
  expect(mergeProgressIdentity('git.merge.worker.report', { summary: 'still working' }, {})).toBeUndefined();
});

it('counts new file pages, content revisions, resolved files and check results', () => {
  const read = (revision: string, offset: number) => mergeProgressIdentity('git.merge.worker.read', { fileId: 'file', offset }, { revision, content: 'same' });
  expect(read('v1', 0)).not.toBe(read('v1', 100));
  expect(read('v1', 0)).not.toBe(read('v2', 0));
  const checks = (status: string) => mergeProgressIdentity('git.merge.worker.checks', {}, { mr: { checkResults: [{ id: 'check', tree: 'tree', status }] } });
  expect(checks('passed')).not.toBe(checks('failed'));
});
