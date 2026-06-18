import { describe, it, expect } from 'vitest';
import { buildWikiDocumentTree } from '../tools/agent-context.js';

describe('buildWikiDocumentTree', () => {
  it('builds a sorted hierarchical tree', () => {
    const tree = buildWikiDocumentTree([
      { id: 'b', title: 'Child B', docType: 'module', parentId: 'root', contentMd: 'body', sortOrder: 2 },
      { id: 'a', title: 'Child A', docType: 'module', parentId: 'root', contentMd: '', sortOrder: 1 },
      { id: 'root', title: 'Root', docType: 'landscape', parentId: null, contentMd: 'root body', sortOrder: 0 },
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe('root');
    expect(tree[0].hasContent).toBe(true);
    expect(tree[0].children.map((c) => c.id)).toEqual(['a', 'b']);
    expect(tree[0].children[0].hasContent).toBe(false);
  });
});
