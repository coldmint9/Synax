import type { GoalAnchor } from './wiki-goal-service.js'
import { searchWikiDocuments } from './wiki-fts.js'
import { wikiStore } from './wiki-store.js'
import type { WikiDocument } from './contracts.js'

export type GoalWikiAttachMode = 'auto' | 'manual'

export type ResolvedGoalWikiContext = {
  mode: GoalWikiAttachMode
  documentId: string | null
  documentTitle: string | null
  anchorJson: GoalAnchor | null
  autoMatched: boolean
}

export function isGeneratedWikiDocument(doc: Pick<WikiDocument, 'isSection' | 'contentMd'>): boolean {
  return !doc.isSection && doc.contentMd.trim().length > 0
}

export async function resolveGoalWikiContext(input: {
  projectId: string
  goalContent: string
  mode: GoalWikiAttachMode
  documentId?: string | null
  anchorJson?: GoalAnchor | null
}): Promise<ResolvedGoalWikiContext> {
  if (input.mode === 'manual') {
    if (!input.documentId) {
      return {
        mode: 'manual',
        documentId: null,
        documentTitle: null,
        anchorJson: input.anchorJson ?? null,
        autoMatched: false,
      }
    }
    const doc = await wikiStore.getDocument(input.documentId)
    if (!doc || !isGeneratedWikiDocument(doc)) {
      return {
        mode: 'manual',
        documentId: null,
        documentTitle: null,
        anchorJson: null,
        autoMatched: false,
      }
    }
    return {
      mode: 'manual',
      documentId: doc.id,
      documentTitle: doc.title,
      anchorJson: input.anchorJson ?? null,
      autoMatched: false,
    }
  }

  const results = searchWikiDocuments({
    projectId: input.projectId,
    query: input.goalContent,
    limit: 8,
  })
  for (const hit of results) {
    const doc = await wikiStore.getDocument(hit.documentId)
    if (doc && isGeneratedWikiDocument(doc)) {
      return {
        mode: 'auto',
        documentId: doc.id,
        documentTitle: doc.title,
        anchorJson: null,
        autoMatched: true,
      }
    }
  }

  return {
    mode: 'auto',
    documentId: null,
    documentTitle: null,
    anchorJson: null,
    autoMatched: false,
  }
}
