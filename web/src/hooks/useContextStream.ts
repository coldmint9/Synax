// ---------------------------------------------------------------------------
// web/src/hooks/useContextStream.ts
//
// \u8ba2\u9605\u5f53\u524d projectId \u7684\u4e0a\u4e0b\u6587\u540c\u6b65 SSE\uff0c\u5c06\u4e8b\u4ef6\u6d41\u6ce8\u5165 contextStore\u3002
// \u5355\u4f8b\u8fde\u63a5\uff1aprojectId \u53d8\u5316\u65f6\u5173\u95ed\u65e7 EventSource\uff0c\u5f00\u542f\u65b0\u7684\u3002
// ---------------------------------------------------------------------------

import { useEffect } from 'react'
import { contextApi } from '../lib/api/context'
import { useContextStore } from '../react/state/contextStore'

export function useContextStream(): void {
  const projectId = useContextStore((s) => s.projectId)
  const applySyncEvent = useContextStore((s) => s.applySyncEvent)
  const setSyncStatus = useContextStore((s) => s.setSyncStatus)

  useEffect(() => {
    if (!projectId) {
      setSyncStatus('idle')
      return
    }

    setSyncStatus('connecting')
    let closed = false

    const unsubscribe = contextApi.subscribeSync(projectId, (event) => {
      if (closed) return
      if (event.type === 'ready') {
        setSyncStatus('connected')
        return
      }
      if (event.type === 'ping') return
      applySyncEvent(event)
    })

    return () => {
      closed = true
      unsubscribe()
      setSyncStatus('idle')
    }
  }, [projectId, applySyncEvent, setSyncStatus])
}
