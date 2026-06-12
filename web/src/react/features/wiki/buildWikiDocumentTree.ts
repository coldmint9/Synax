import type { WikiDocument } from '../../../lib/contracts/wiki'

export interface WikiDocTreeNode {
  document: WikiDocument
  children: WikiDocTreeNode[]
}

function sortByOrder(a: WikiDocument, b: WikiDocument): number {
  return (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
}

function buildSubtree(
  document: WikiDocument,
  childrenByParent: Map<string, WikiDocument[]>,
): WikiDocTreeNode {
  const children = (childrenByParent.get(document.id) ?? [])
    .slice()
    .sort(sortByOrder)
    .map(child => buildSubtree(child, childrenByParent))

  return { document, children }
}

/**
 * Build a hierarchical document tree from parentId links.
 * Orphans (missing parent) and root documents (parentId null) become top-level nodes.
 */
export function buildWikiDocumentTree(documents: WikiDocument[]): WikiDocTreeNode[] {
  if (documents.length === 0) return []

  const byId = new Map(documents.map(d => [d.id, d]))
  const childrenByParent = new Map<string, WikiDocument[]>()

  for (const doc of documents) {
    const parentId = doc.parentId
    if (parentId && byId.has(parentId)) {
      const siblings = childrenByParent.get(parentId) ?? []
      siblings.push(doc)
      childrenByParent.set(parentId, siblings)
    }
  }

  const roots = documents
    .filter(doc => !doc.parentId || !byId.has(doc.parentId))
    .slice()
    .sort(sortByOrder)

  return roots.map(root => buildSubtree(root, childrenByParent))
}
