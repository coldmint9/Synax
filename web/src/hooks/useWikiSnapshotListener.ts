import { useEffect } from 'react'
import { TaskNotificationEventType } from '../lib/api/eventTypes'
import { subscribe } from '../lib/api/taskNotificationBus'
import type { WikiDocument, WikiSnapshotTree } from '../lib/contracts/wiki'
import { useWikiStore } from '../react/state/wikiStore'

interface WikiSnapshotPayload {
  type: typeof TaskNotificationEventType.WikiSnapshot
  projectId: string
  tree: WikiSnapshotTree
}

interface WikiDocumentCommittedPayload {
  type: typeof TaskNotificationEventType.DocumentCommitted
  projectId: string
  documentId: string
  document: WikiDocument
}

export function useWikiSnapshotListener(projectId: string | null) {
  useEffect(() => {
    if (!projectId) return

    const handleSnapshot = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as WikiSnapshotPayload
        if (data.type !== TaskNotificationEventType.WikiSnapshot) return
        if (data.projectId !== projectId) return
        useWikiStore.getState().applySnapshotTree(data.tree)
      } catch (err) {
        console.warn('[useWikiSnapshotListener] Failed to process wiki_snapshot event:', err)
      }
    }

    const handleDocumentCommitted = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as WikiDocumentCommittedPayload
        if (data.type !== TaskNotificationEventType.DocumentCommitted) return
        if (data.projectId !== projectId) return
        useWikiStore.getState().applyDocumentUpdate(data.document)
      } catch (err) {
        console.warn('[useWikiSnapshotListener] Failed to process document_committed event:', err)
      }
    }

    return subscribe(projectId, {
      events: {
        [TaskNotificationEventType.WikiSnapshot]: handleSnapshot,
        [TaskNotificationEventType.DocumentCommitted]: handleDocumentCommitted,
      },
    })
  }, [projectId])
}
