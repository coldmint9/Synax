/**
 * Copies text to the system clipboard.
 *
 * `navigator.clipboard` rejects while the document is not focused (which
 * happens whenever the app window sits behind another one), so fall back to a
 * hidden selection + `execCommand('copy')`, which only needs a user gesture.
 * Returns whether the write actually succeeded so callers can avoid showing a
 * success state for a copy that never happened.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && document.hasFocus()) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }

  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(area)
    return copied
  } catch {
    return false
  }
}
