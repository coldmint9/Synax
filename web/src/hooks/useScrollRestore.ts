import { useEffect, useRef, useCallback } from 'react'

const STORAGE_KEY = 'wiki-scroll-positions'
const MAX_ENTRIES = 20

function loadPositions(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch {
    return {}
  }
}

function savePositions(positions: Record<string, number>) {
  const keys = Object.keys(positions)
  if (keys.length > MAX_ENTRIES) {
    const trimmed: Record<string, number> = {}
    keys.slice(-MAX_ENTRIES).forEach(k => { trimmed[k] = positions[k] })
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(positions))
  }
}

export function useScrollRestore(key: string | null) {
  const containerRef = useRef<HTMLDivElement>(null)
  const currentKey = useRef(key)
  const restored = useRef(false)

  const persist = useCallback(() => {
    const el = containerRef.current
    if (!currentKey.current || !el) return
    const positions = loadPositions()
    positions[currentKey.current] = el.scrollTop
    savePositions(positions)
  }, [])

  useEffect(() => {
    if (currentKey.current && currentKey.current !== key) {
      persist()
    }
    currentKey.current = key
    restored.current = false
  }, [key, persist])

  useEffect(() => {
    if (!key || restored.current) return
    const el = containerRef.current
    if (!el) return
    const positions = loadPositions()
    const saved = positions[key]
    if (saved != null) {
      requestAnimationFrame(() => { el.scrollTop = saved })
    }
    restored.current = true
  }, [key])

  useEffect(() => {
    const onBlur = () => persist()
    const onVisibility = () => { if (document.hidden) persist() }
    const onUnload = () => persist()

    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('beforeunload', onUnload)
    return () => {
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('beforeunload', onUnload)
    }
  }, [persist])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout>
    const onScroll = () => {
      clearTimeout(timer)
      timer = setTimeout(persist, 300)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      clearTimeout(timer)
      el.removeEventListener('scroll', onScroll)
    }
  }, [persist, key])

  useEffect(() => () => { persist() }, [persist])

  return containerRef
}
