import { ArrowLeftRight, X } from 'lucide-react'
import { useLocale } from '../../hooks/useLocale'
import type { ActivityPanel } from './ActivityBar'

interface SidePanelProps {
  activePanel: ActivityPanel | null
  open: boolean
  position: 'left' | 'right'
  onClose: () => void
  onFlipPosition: () => void
  children?: React.ReactNode
}

export function SidePanel({ activePanel, open, position, onClose, onFlipPosition, children }: SidePanelProps) {
  const { t } = useLocale()

  const panelTitles: Record<ActivityPanel, string> = {
    wiki: 'Wiki',
    sessions: t('titlebarAgent'),
    search: t('panelSearch'),
    settings: t('panelSettings'),
    projects: t('panelProjects'),
  }

  return (
    <div
      className={`side-panel${open ? ' side-panel-open' : ''}${position === 'right' ? ' side-panel-right' : ''}`}
    >
      <div className="sp-header">
        <span className="sp-title">{activePanel ? panelTitles[activePanel] : ''}</span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className="sp-btn"
            title={t('commonFlipPanel')}
            onClick={onFlipPosition}
          >
            <ArrowLeftRight size={13} />
          </button>
          <button
            type="button"
            className="sp-btn"
            title={t('commonClose')}
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="sp-content">
        {children}
      </div>
    </div>
  )
}
