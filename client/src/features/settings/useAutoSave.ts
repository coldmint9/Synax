import { useCallback, useRef, useState } from 'react'

interface AutoSaveOptions {
  debounceMs?: number
}

export function useAutoSave<T>(
  saveFn: (value: T) => Promise<void>,
  options: AutoSaveOptions = {},
) {
  const { debounceMs = 300 } = options
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const doSave = useCallback(async (value: T) => {
    setSaving(true)
    setError(null)
    try {
      await saveFn(value)
      setSaved(true)
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
      savedTimerRef.current = setTimeout(() => setSaved(false), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [saveFn])

  const save = useCallback((value: T) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => void doSave(value), debounceMs)
  }, [doSave, debounceMs])

  const saveImmediate = useCallback((value: T) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    void doSave(value)
  }, [doSave])

  return { save, saveImmediate, saving, saved, error }
}
