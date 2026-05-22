import { Search, Monitor, Bell } from 'lucide-react'
import type { ActivityPanel } from './ActivityBar'

interface TitleBarProps {
  projectName: string
  onPanelToggle: (panel: ActivityPanel) => void
}

export function TitleBar({ projectName, onPanelToggle }: TitleBarProps) {
  return (
    <div className="titlebar">
      <div className="titlebar-info">
        <button
          type="button"
          className="titlebar-project cursor-pointer hover:text-primary transition"
          onClick={() => onPanelToggle('projects')}
        >
          {projectName}
        </button>
      </div>
      <div className="titlebar-actions">
        <button
          type="button"
          title="搜索"
          className="titlebar-action-btn"
          onClick={() => onPanelToggle('search')}
        >
          <Search size={14} />
        </button>
        <button
          type="button"
          title="会话"
          className="titlebar-action-btn"
          onClick={() => onPanelToggle('sessions')}
        >
          <Monitor size={14} />
        </button>
        <button
          type="button"
          title="通知"
          className="titlebar-action-btn"
        >
          <Bell size={14} />
        </button>
      </div>
    </div>
  )
}
