import type { WikiDocument } from '../../../lib/contracts/wiki'

export interface WikiDocTreeNode {
  document: WikiDocument
  children: WikiDocTreeNode[]
}

function sortByOrder(a: WikiDocument, b: WikiDocument): number {
  return (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
}

function sortByCreatedAt(a: WikiDocument, b: WikiDocument): number {
  const byTime = a.createdAt.localeCompare(b.createdAt)
  if (byTime !== 0) return byTime
  return sortByOrder(a, b)
}

function hasParentLinks(documents: WikiDocument[]): boolean {
  const byId = new Set(documents.map(d => d.id))
  return documents.some(d => d.parentId != null && d.parentId !== '' && byId.has(d.parentId))
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
 * Group flat outlines where sections and pages share no parentId links.
 * Pages are emitted after sections in creation order; sortOrder restarting at 1
 * marks the first page of the next section.
 */
function buildFlatSectionTree(documents: WikiDocument[]): WikiDocTreeNode[] {
  const sections = documents.filter(d => d.isSection).slice().sort(sortByOrder)
  if (sections.length === 0) {
    return documents
      .slice()
      .sort(sortByOrder)
      .map(doc => ({ document: doc, children: [] }))
  }

  const pages = documents.filter(d => !d.isSection).slice().sort(sortByCreatedAt)
  const pagesBySection = new Map<string, WikiDocument[]>(
    sections.map(section => [section.id, []]),
  )

  let sectionIndex = 0
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    if (i > 0 && (page.sortOrder ?? 0) === 1) {
      sectionIndex = Math.min(sectionIndex + 1, sections.length - 1)
    }
    const section = sections[sectionIndex]
    if (!section) continue
    pagesBySection.get(section.id)!.push(page)
  }

  return sections.map(section => ({
    document: section,
    children: (pagesBySection.get(section.id) ?? [])
      .sort(sortByOrder)
      .map(page => ({ document: page, children: [] })),
  }))
}

/**
 * Build a hierarchical document tree from parentId links.
 * Falls back to section grouping for flat legacy outlines without parentId.
 */
export function buildWikiDocumentTree(documents: WikiDocument[]): WikiDocTreeNode[] {
  if (documents.length === 0) return []

  if (!hasParentLinks(documents)) {
    const hasSections = documents.some(d => d.isSection)
    if (hasSections) {
      return buildFlatSectionTree(documents)
    }

    return documents
      .slice()
      .sort(sortByOrder)
      .map(doc => ({ document: doc, children: [] }))
  }

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
