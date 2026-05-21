import { BrainCircuit, BookOpen, Monitor, Search, Settings2, Sun, Moon, Home } from 'lucide-react'
import { useShellStore } from '../state/shellStore'

export type ActivityPanel = 'coordinates' | 'wiki' | 'sessions' | 'search' | 'settings' | 'projects'

interface ActivityBarProps {
  activePanel: ActivityPanel | null
  onPanelToggle: (panel: ActivityPanel) => void
  onHome: () => void
  hasProject: boolean
}

const topItems: { id: ActivityPanel; icon: typeof BrainCircuit; label: string }[] = [
  { id: 'coordinates', icon: BrainCircuit, label: 'Coordinates' },
  { id: 'wiki', icon: BookOpen, label: 'Wiki' },
  { id: 'sessions', icon: Monitor, label: 'Sessions' },
  { id: 'search', icon: Search, label: '搜索' },
]

const bottomItems: { id: ActivityPanel; icon: typeof Settings2; label: string }[] = [
  { id: 'settings', icon: Settings2, label: '设置' },
]

export function ActivityBar({ activePanel, onPanelToggle, onHome, hasProject }: ActivityBarProps) {
  const theme = useShellStore(s => s.preferences.theme)
  const setTheme = useShellStore(s => s.setTheme)

  const projectPanels: Set<ActivityPanel> = new Set(['coordinates', 'wiki', 'sessions'])

  return (
    <div className="activity-bar">
      <div className="flex flex-col items-center gap-1">
        {topItems.map(item => {
          const Icon = item.icon
          const isActive = activePanel === item.id
          const disabled = projectPanels.has(item.id) && !hasProject
          return (
            <button
              key={item.id}
              type="button"
              title={disabled ? `${item.label}（需先选择项目）` : item.label}
              className={`ab-item${isActive ? ' ab-item-active' : ''}${disabled ? ' ab-item-disabled' : ''}`}
              onClick={() => !disabled && onPanelToggle(item.id)}
              disabled={disabled}
            >
              <Icon size={20} />
            </button>
          )
        })}
      </div>
      <div className="mt-auto flex flex-col items-center gap-1">
        {bottomItems.map(item => {
          const Icon = item.icon
          const isActive = activePanel === item.id
          return (
            <button
              key={item.id}
              type="button"
              title={item.label}
              className={`ab-item${isActive ? ' ab-item-active' : ''}`}
              onClick={() => onPanelToggle(item.id)}
            >
              <Icon size={20} />
            </button>
          )
        })}
        <button
          type="button"
          title="首页"
          className="ab-item"
          onClick={onHome}
        >
          <Home size={18} />
        </button>
        <button
          type="button"
          title={theme === 'dark' ? '浅色模式' : '深色模式'}
          className="ab-item"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </div>
    </div>
  )
}
