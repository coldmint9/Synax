import { useEffect, useRef } from 'react'

const focusableSelector = 'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'

/** Dialog content mounts once per opening; a child dialog can pause the trap. */
export function useDialogFocus(onClose: () => void, paused = false) {
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    const initialFocus = dialog?.querySelector<HTMLElement>('[data-dialog-autofocus]')
      ?? dialog?.querySelector<HTMLElement>(focusableSelector)
      ?? dialog
    initialFocus?.focus()
    return () => {
      if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) previousFocus.focus()
    }
  }, [])

  useEffect(() => {
    if (paused) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      const dialog = dialogRef.current
      if (event.key !== 'Tab' || !dialog) return
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
        .filter(element => element.tabIndex >= 0 && !element.closest('[hidden], [inert], [aria-hidden="true"]'))
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (!first || !dialog.contains(document.activeElement) || document.activeElement === dialog) {
        event.preventDefault()
        ;(event.shiftKey ? last ?? dialog : first ?? dialog).focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, paused])

  return dialogRef
}
