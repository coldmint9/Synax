import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileSessionSearchStore,
  MAX_STORED_CHARS,
  boundDocuments,
} from '../search-store.js';
import { buildSessionSearchDocument } from '../search-documents.js';
import { searchMessage as message, searchSession as session } from './search-fixtures.js';

const roots: string[] = [];

async function temporaryStore() {
  const root = await mkdtemp(path.join(tmpdir(), 'synax-search-'));
  roots.push(root);
  return {
    directory: path.join(root, 'index'),
    store: new FileSessionSearchStore(path.join(root, 'index')),
  };
}

/** One indexed message per 3k chars, capped by the per-session budget. */
function document(id: string, updatedAt: string) {
  return buildSessionSearchDocument(session({ id, updatedAt, title: `标题 ${id}` }), [
    message('m1', 'user', `关键字 ${id} ${'填充'.repeat(1_400)}`, '2026-01-01T00:00:01.000Z'),
  ]);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileSessionSearchStore', () => {
  it('round-trips the compressed index', async () => {
    const { store } = await temporaryStore();
    expect(await store.load('p1')).toEqual([]);

    const original = document('s1', '2026-01-01T00:00:00.000Z');
    await store.save('p1', [original]);

    const [restored] = await store.load('p1');
    expect(restored.sessionId).toBe(original.sessionId);
    expect(restored.haystack).toBe(original.haystack);
    expect(restored.stamp).toBe(original.stamp);
    expect(restored.segments).toEqual(original.segments);
  });

  it('treats a damaged file as a cold index instead of failing the search', async () => {
    const { directory, store } = await temporaryStore();
    await store.save('p1', [document('s1', '2026-01-01T00:00:00.000Z')]);
    const [file] = await readdir(directory);
    await writeFile(path.join(directory, file), 'not gzip');

    expect(await store.load('p1')).toEqual([]);
  });

  it('keeps a workspace index well under the raw transcript size', async () => {
    const { store } = await temporaryStore();
    const documents = Array.from({ length: 5 }, (_, index) =>
      document(
        `s${index}`,
        new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      ),
    );
    await store.save('p1', documents);

    const stored = await store.load('p1');
    expect(stored.reduce((total, entry) => total + entry.chars, 0)).toBeLessThanOrEqual(
      MAX_STORED_CHARS,
    );
  });
});

describe('boundDocuments', () => {
  it('keeps labels for conversations that no longer fit the text budget', () => {
    const newest = document('s2', '2026-01-01T00:00:02.000Z');
    const middle = document('s1', '2026-01-01T00:00:01.000Z');
    const oldest = document('s0', '2026-01-01T00:00:00.000Z');
    const budget = newest.chars + middle.chars + 100;

    const bounded = boundDocuments([oldest, newest, middle], budget);

    expect(bounded.map((entry) => entry.sessionId)).toEqual(['s2', 's1', 's0']);
    expect(bounded[0].segments.some((seg) => seg.kind === 'message')).toBe(true);
    expect(bounded[2].segments.some((seg) => seg.kind === 'message')).toBe(false);
    expect(bounded[2].haystack).toContain('标题 s0');
    expect(bounded[2].truncated).toBe(true);
  });
});
