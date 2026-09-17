import { useCallback, useEffect, useRef, useState } from 'react'
import { draftToConnection, draftToProviderDef, type ApiProviderDraft } from './lib/providerPresets'
import { validateProviderDraft } from './lib/validation'

function saveKey(draft: ApiProviderDraft) {
  // Discovery results and connection-test messages are UI state, not configuration.
  return JSON.stringify([draftToProviderDef(draft), draftToConnection(draft)])
}

export function useProviderAutoSave(draft: ApiProviderDraft, onSave: (draft: ApiProviderDraft) => Promise<void>) {
  const key = saveKey(draft)
  const valid = validateProviderDraft(draft).length === 0
  const latest = useRef({ draft, key, valid, onSave })
  latest.current = { draft, key, valid, onSave }
  const lastSaved = useRef(key)
  const pending = useRef<Promise<boolean> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)
  const [saving, setSaving] = useState(false)
  const [savedKey, setSavedKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const flush = useCallback((): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current)
    if (pending.current) return pending.current
    const run = async () => {
      setError(null)
      setSaving(true)
      try {
        // Serialize requests and drain edits made while a request was in flight.
        while (mounted.current) {
          const current = latest.current
          if (current.key === lastSaved.current) return true
          if (!current.valid) return false
          await current.onSave(current.draft)
          lastSaved.current = current.key
          if (mounted.current) setSavedKey(current.key)
        }
        return false
      } catch (err) {
        if (mounted.current) setError(err instanceof Error ? err.message : '保存失败')
        return false
      } finally {
        pending.current = null
        if (mounted.current) setSaving(false)
      }
    }
    // Defer execution so even a synchronous early return clears pending correctly.
    pending.current = Promise.resolve().then(run)
    return pending.current
  }, [])

  useEffect(() => {
    setError(null)
    if (!valid || key === lastSaved.current) return
    timer.current = setTimeout(() => { void flush() }, 500)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [key, valid, flush])

  return { saving, saved: savedKey === key, error, flush, valid }
}
