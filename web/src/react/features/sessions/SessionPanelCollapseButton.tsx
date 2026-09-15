import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useLocale } from '../../../hooks/useLocale'

interface Props {
  collapsed: boolean
  onToggle: () => void
}

/**
 * Edge control for the left session panel. It uses the standard sidebar-panel
 * glyph in both directions (`panel-left-close` while open, `panel-left-open`
 * on the collapsed rail) so the affordance reads as a sidebar toggle rather
 * than a generic back/forward chevron.
 */
export function SessionPanelCollapseButton({ collapsed, onToggle }: Props) {
  const { t } = useLocale()
  const label = collapsed ? t('appExpandSidebar') : t('appCollapseSidebar')

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onToggle}
      className="session-panel-collapse session-panel-collapse--left"
    >
      {collapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
    </button>
  )
}
