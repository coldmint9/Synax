import type { WikiDocument } from '../../../lib/contracts/wiki'
import { countWritableDocuments, countWrittenDocuments } from './wikiDocumentCounts'

export interface WikiGenProgressCounts {
  docIndex?: number
  totalDocs?: number
  doneDocs?: number
  docTitle?: string
  documentId?: string
}

export function resolveGeneratingDocumentId(
  documents: WikiDocument[],
  genProgress: WikiGenProgressCounts | null | undefined,
  isActivelyWriting: boolean,
  snapshotStatus?: string | null,
): string | null {
  const writing = isActivelyWriting || snapshotStatus === 'writing'
  if (!writing) return null
  if (genProgress.documentId && documents.some(d => d.id === genProgress.documentId)) {
    return genProgress.documentId
  }
  if (genProgress?.docTitle) {
    return documents.find(d => !d.isSection && d.title === genProgress.docTitle)?.id ?? null
  }
  return null
}

export function resolveWikiWritingProgressCounts(
  documents: WikiDocument[],
  genProgress: WikiGenProgressCounts | null | undefined,
): { done: number; total: number; percent: number | undefined } {
  const fromDocs = {
    done: countWrittenDocuments(documents),
    total: countWritableDocuments(documents),
  }

  const total = fromDocs.total > 0
    ? fromDocs.total
    : (genProgress?.totalDocs ?? 0)

  const done = genProgress?.doneDocs != null
    ? Math.max(fromDocs.done, genProgress.doneDocs)
    : fromDocs.done

  const clampedDone = total > 0 ? Math.min(done, total) : done

  const percent = total > 0
    ? Math.min(100, Math.round((clampedDone / total) * 100))
    : undefined

  return { done: clampedDone, total, percent }
}
