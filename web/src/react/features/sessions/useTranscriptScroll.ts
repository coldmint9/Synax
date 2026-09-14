import { useEffect, type RefObject } from 'react'

/** Follow streamed growth only while pinned; manual history browsing is a separate signal. */
export function useTranscriptScroll(scrollRef: RefObject<HTMLDivElement | null>, sessionId?: string, onReadingHistoryChange?: (reading: boolean) => void) {
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const content = element.firstElementChild
    let pinned = true
    let readingHistory = false
    let manualUntil = 0
    let pointerDown = false
    let lastTop = element.scrollTop
    const publish = (reading: boolean) => {
      if (readingHistory === reading) return
      readingHistory = reading
      onReadingHistoryChange?.(reading)
    }
    const markManual = () => { manualUntil = performance.now() + 1000 }
    const handlePointerDown = () => { pointerDown = true; markManual() }
    const handlePointerUp = () => { pointerDown = false }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) markManual()
    }
    const handleScroll = () => {
      const top = element.scrollTop
      const distance = element.scrollHeight - top - element.clientHeight
      pinned = distance <= 48
      if (distance <= 32) publish(false)
      else if (distance >= 96 && top < lastTop - 1 && (pointerDown || performance.now() <= manualUntil)) publish(true)
      lastTop = top
    }
    element.addEventListener('scroll', handleScroll, { passive: true })
    element.addEventListener('wheel', markManual, { passive: true })
    element.addEventListener('touchmove', markManual, { passive: true })
    element.addEventListener('pointerdown', handlePointerDown)
    element.addEventListener('keydown', handleKeyDown)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    element.scrollTop = element.scrollHeight
    lastTop = element.scrollTop
    onReadingHistoryChange?.(false)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (pinned) { element.scrollTop = element.scrollHeight; lastTop = element.scrollTop }
    })
    if (observer && content) observer.observe(content)
    return () => {
      element.removeEventListener('scroll', handleScroll)
      element.removeEventListener('wheel', markManual)
      element.removeEventListener('touchmove', markManual)
      element.removeEventListener('pointerdown', handlePointerDown)
      element.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      observer?.disconnect()
      onReadingHistoryChange?.(false)
    }
  }, [scrollRef, sessionId, onReadingHistoryChange])
}
