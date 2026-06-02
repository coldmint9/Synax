import { useEffect } from 'react'
import { TaskNotificationEventType } from '../lib/api/eventTypes'
import { subscribe } from '../lib/api/taskNotificationBus'
import type { WikiSnapshotTree } from '../lib/contracts/wiki'
import { useWikiStore } from '../react/state/wikiStore'

interface WikiSnapshotPayload {
  type: typeof TaskNotificationEventType.WikiSnapshot
  projectId: string
  tree: WikiSnapshotTree
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
      } catch { /* ignore parse errors */ }
    }

    return subscribe(projectId, {
      events: {
        [TaskNotificationEventType.WikiSnapshot]: handleSnapshot,
      },
    })
  }, [projectId])
}
