import { describe, it, expect } from 'vitest'
import { buildWikiDocumentTree } from '../buildWikiDocumentTree'
import type { WikiDocument } from '../../../../lib/contracts/wiki'

function makeDoc(partial: Partial<WikiDocument> & Pick<WikiDocument, 'id' | 'title'>): WikiDocument {
  return {
    snapshotId: 'snap-1',
    projectId: 'proj-1',
    docType: 'module',
    sortOrder: 0,
    parentId: null,
    contentMd: '',
    references: [],
    pipelineStage: 'pending',
    manualState: 'none',
    staleState: 'fresh',
    isSection: false,
    createdAt: '',
    updatedAt: '',
    ...partial,
  }
}

describe('buildWikiDocumentTree', () => {
  it('builds nested tree sorted by sortOrder at each level', () => {
    const documents = [
      makeDoc({ id: 'root', title: 'Overview', sortOrder: 0 }),
      makeDoc({ id: 'arch', title: 'Architecture', parentId: 'root', sortOrder: 1 }),
      makeDoc({ id: 'mod-b', title: 'Module B', parentId: 'modules', sortOrder: 2 }),
      makeDoc({ id: 'mod-a', title: 'Module A', parentId: 'modules', sortOrder: 1 }),
      makeDoc({ id: 'modules', title: 'Core Subsystems', parentId: 'root', sortOrder: 2, isSection: true }),
    ]

    const tree = buildWikiDocumentTree(documents)
    expect(tree).toHaveLength(1)
    expect(tree[0].document.id).toBe('root')
    expect(tree[0].children.map(n => n.document.id)).toEqual(['arch', 'modules'])

    const modulesNode = tree[0].children[1]
    expect(modulesNode.document.isSection).toBe(true)
    expect(modulesNode.children.map(n => n.document.id)).toEqual(['mod-a', 'mod-b'])
  })

  it('promotes orphans with missing parent to root', () => {
    const documents = [
      makeDoc({ id: 'root', title: 'Overview' }),
      makeDoc({ id: 'orphan', title: 'Lost Child', parentId: 'missing', sortOrder: 1 }),
    ]

    const tree = buildWikiDocumentTree(documents)
    expect(tree.map(n => n.document.id).sort()).toEqual(['orphan', 'root'])
    expect(tree.find(n => n.document.id === 'orphan')!.children).toEqual([])
  })

  it('returns flat roots for legacy snapshots without nesting', () => {
    const documents = [
      makeDoc({ id: 'a', title: 'First', sortOrder: 2 }),
      makeDoc({ id: 'b', title: 'Second', sortOrder: 1 }),
      makeDoc({ id: 'c', title: 'Third', sortOrder: 3 }),
    ]

    const tree = buildWikiDocumentTree(documents)
    expect(tree).toHaveLength(3)
    expect(tree.map(n => n.document.id)).toEqual(['b', 'a', 'c'])
    expect(tree.every(n => n.children.length === 0)).toBe(true)
  })

  it('groups flat section outlines without parentId by creation order', () => {
    const documents = [
      makeDoc({ id: 'sec-a', title: 'Overview', sortOrder: 1, isSection: true, createdAt: '2026-01-01T00:00:01Z' }),
      makeDoc({ id: 'sec-b', title: 'Architecture', sortOrder: 2, isSection: true, createdAt: '2026-01-01T00:00:02Z' }),
      makeDoc({ id: 'page-a1', title: 'Landscape', sortOrder: 1, createdAt: '2026-01-01T00:00:03Z' }),
      makeDoc({ id: 'page-b1', title: 'Topology', sortOrder: 1, createdAt: '2026-01-01T00:00:04Z' }),
      makeDoc({ id: 'page-b2', title: 'Auth Module', sortOrder: 2, createdAt: '2026-01-01T00:00:05Z' }),
    ]

    const tree = buildWikiDocumentTree(documents)
    expect(tree).toHaveLength(2)
    expect(tree[0].document.id).toBe('sec-a')
    expect(tree[0].children.map(n => n.document.id)).toEqual(['page-a1'])
    expect(tree[1].document.id).toBe('sec-b')
    expect(tree[1].children.map(n => n.document.id)).toEqual(['page-b1', 'page-b2'])
  })
})
