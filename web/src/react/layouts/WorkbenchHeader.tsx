import { Tabs } from '@heroui/react'
import { BookOpen, Monitor, Search, Settings2, Sun, Moon, Home, Zap } from 'lucide-react'
import { useShellStore } from '../state/shellStore'
import { useWikiStore, type WikiViewMode } from '../state/wikiStore'
import type { ActivityPanel } from './ActivityBar'

interface WorkbenchHeaderProps {
  activePanel: ActivityPanel | null
  onPanelToggle: (panel: ActivityPanel) => void
  onHome: () => void
  hasProject: boolean
}

const navTabs: { id: ActivityPanel; icon: typeof BookOpen; label: string; requiresProject: boolean }[] = [
  { id: 'wiki', icon: BookOpen, label: 'Wiki', requiresProject: true },
  { id: 'sessions', icon: Monitor, label: 'Sessions', requiresProject: true },
]

function WikiToolbar() {
  const viewMode = useWikiStore(s => s.viewMode)
  const setViewMode = useWikiStore(s => s.setViewMode)
  const patchesPending = useWikiStore(s => s.patchesSummary.pending)
  const togglePatchPanel = useWikiStore(s => s.togglePatchPanel)

  const items: { id: WikiViewMode; label: string }[] = [
    { id: 'document', label: '文档' },
    { id: 'plan', label: '规划' },
  ]

  return (
    <div className="flex items-center gap-0.5">
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          onClick={() => setViewMode(item.id)}
          className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
            viewMode === item.id
              ? 'text-primary'
              : 'text-muted-foreground/50 hover:text-muted-foreground'
          }`}
        >
          {item.label}
        </button>
      ))}
      <div className="wh-divider" />
      <button type="button" className="wh-btn relative" title="Patches" onClick={togglePatchPanel}>
        <Zap size={13} />
        {patchesPending > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-warning px-0.5 text-[8px] font-bold text-warning-foreground">
            {patchesPending}
          </span>
        )}
      </button>
      <button type="button" className="wh-btn" title="搜索">
        <Search size={13} />
      </button>
    </div>
  )
}

export function WorkbenchHeader({ activePanel, onPanelToggle, onHome, hasProject }: WorkbenchHeaderProps) {
  const theme = useShellStore(s => s.preferences.theme)
  const setTheme = useShellStore(s => s.setTheme)

  return (
    <div className="workbench-header">
      <div className="wh-pill">
        <button type="button" className="wh-btn" title="首页" onClick={onHome}>
          <Home size={15} />
        </button>

        <div className="wh-divider" />

        <Tabs
          selectedKey={activePanel ?? ''}
          onSelectionChange={(key) => onPanelToggle(key as ActivityPanel)}
          className="wh-tabs"
        >
          <Tabs.ListContainer>
            <Tabs.List aria-label="主导航" className="wh-tabs-list">
              {navTabs.map((tab, i) => {
                const Icon = tab.icon
                const disabled = tab.requiresProject && !hasProject
                return (
                  <Tabs.Tab
                    key={tab.id}
                    id={tab.id}
                    isDisabled={disabled}
                    className="wh-tab"
                  >
                    {i > 0 && <Tabs.Separator />}
                    <Icon size={13} />
                    <span>{tab.label}</span>
                    <Tabs.Indicator />
                  </Tabs.Tab>
                )
              })}
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>

        <div className="wh-divider" />

        <div className="wh-actions">
          <button
            type="button"
            className="wh-btn"
            title="设置"
            onClick={() => onPanelToggle('settings')}
          >
            <Settings2 size={15} />
          </button>
          <button
            type="button"
            className="wh-btn"
            title={theme === 'dark' ? '浅色模式' : '深色模式'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>
      </div>

      {activePanel === 'wiki' && (
        <div className="wh-pill">
          <WikiToolbar />
        </div>
      )}
    </div>
  )
}
