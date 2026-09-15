import { ChevronLeft } from 'lucide-react'
import { useLocale } from '../../../hooks/useLocale'
import { SynaxMark } from '../../components/SynaxMark'

interface Props {
  collapsed: boolean
  onToggle: () => void
}

/**
 * Edge control for the left session panel. While the panel is collapsed it is
 * the only Synax affordance left on the rail, so it carries the brand mark
 * instead of a bare chevron; the expand affordance stays in the label and in
 * the rightward nudge on hover.
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
      {collapsed ? (
        <SynaxMark size={15} />
      ) : (
        <ChevronLeft size={12} />
      )}
    </button>
  )
}
