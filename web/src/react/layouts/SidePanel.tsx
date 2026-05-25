import { ArrowLeftRight, X } from 'lucide-react'
import type { ActivityPanel } from './ActivityBar'

interface SidePanelProps {
  activePanel: ActivityPanel | null
  open: boolean
  position: 'left' | 'right'
  onClose: () => void
  onFlipPosition: () => void
  children?: React.ReactNode
}

const panelTitles: Record<ActivityPanel, string> = {
  wiki: 'Wiki',
  sessions: 'Sessions',
  search: '搜索',
  settings: '设置',
  projects: '项目',
}

export function SidePanel({ activePanel, open, position, onClose, onFlipPosition, children }: SidePanelProps) {
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
            title="切换面板位置 (左/右)"
            onClick={onFlipPosition}
          >
            <ArrowLeftRight size={13} />
          </button>
          <button
            type="button"
            className="sp-btn"
            title="关闭面板"
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
