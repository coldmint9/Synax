const HIDE_DELAY_MS = 900
const timers = new WeakMap<EventTarget, ReturnType<typeof setTimeout>>()

function isScrollable(el: HTMLElement): boolean {
  if (el.classList.contains('scrollbar-none')) return false
  const style = getComputedStyle(el)
  const overflowY = style.overflowY
  const overflowX = style.overflowX
  if (overflowY === 'auto' || overflowY === 'scroll' || overflowX === 'auto' || overflowX === 'scroll') {
    return true
  }
  return el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth
}

function onScroll(event: Event) {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  if (!isScrollable(target)) return

  target.classList.add('is-scrolling')

  const prev = timers.get(target)
  if (prev !== undefined) clearTimeout(prev)

  timers.set(
    target,
    setTimeout(() => {
      target.classList.remove('is-scrolling')
      timers.delete(target)
    }, HIDE_DELAY_MS),
  )
}

let installed = false

/** Hide scrollbars by default; reveal while an element is actively scrolling. */
export function installScrollRevealScrollbar(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
}
