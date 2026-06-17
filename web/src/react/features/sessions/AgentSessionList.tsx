import { useMemo } from 'react'
import { BookOpen, Compass, ClipboardCheck, Bot, Radio, ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAgentSessionStore } from './agentSessionStore'
import { useSessionDetailPolling } from './useSessionDetailPolling'
import { groupSessions } from './sessionGrouping'
import { GroupedSessionTreeItem } from './GroupedSessionTreeItem'

const GROUP_ICONS: Record<string, typeof Bot> = {
  BookOpen,
  Compass,
  ClipboardCheck,
  Bot,
}

export function AgentSessionList() {
  useSessionDetailPolling()

  const { projectId = '' } = useParams()
  const navigate = useNavigate()
  const sessions = useAgentSessionStore(s => s.sessions)
  const panelOpen = useAgentSessionStore(s => s.panelOpen)
  const selectedSessionId = useAgentSessionStore(s => s.selectedSessionId)
  const openPanel = useAgentSessionStore(s => s.openPanel)
  const closePanel = useAgentSessionStore(s => s.closePanel)

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  const groups = useMemo(() => groupSessions(sessions), [sessions])

  const runningCount = sessions.filter(s =>
    s.status === 'running' || s.status === 'waiting_permission',
  ).length

  const handleSelect = (sessionId: string) => {
    const active = sessionId === selectedSessionId && panelOpen
    if (active) {
      closePanel()
    } else {
      openPanel(sessionId)
      navigate(`/projects/${projectId}/sessions`)
    }
  }

  const toggleGroup = (key: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="flex flex-col text-xs">
      <div className="flex items-center justify-between border-b border-border/40 px-2 py-1.5">
        <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          <Radio size={11} className={runningCount > 0 ? 'text-[var(--color-run)]' : ''} />
          Agent Sessions ({sessions.length})
        </div>
      </div>

      {sessions.length === 0 ? (
        <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
          No active agent sessions
        </div>
      ) : (
        <div className="divide-y divide-border/20">
          {groups.map(group => {
            const Icon = GROUP_ICONS[group.icon] ?? Bot
            const collapsed = collapsedGroups.has(group.key)
            return (
              <div key={group.key}>
                <button
                  type="button"
                  onClick={() => toggleGroup(group.key)}
                  className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-secondary/30"
                >
                  {collapsed
                    ? <ChevronRight size={10} className="text-muted-foreground/60" />
                    : <ChevronDown size={10} className="text-muted-foreground/60" />}
                  <Icon size={11} className="text-muted-foreground/70" />
                  <span className="text-[10px] font-medium text-muted-foreground">
                    {group.label}
                  </span>
                  <span className="text-[9px] text-muted-foreground/50">
                    ({group.sessions.length})
                  </span>
                  {group.isBuiltin && (
                    <span className="ml-auto rounded border border-primary/20 bg-primary/5 px-1 text-[8px] font-medium text-primary/70">
                      内建
                    </span>
                  )}
                </button>
                {!collapsed && (
                  <ul>
                    {group.sessions.map(node => (
                      <GroupedSessionTreeItem
                        key={node.session.id}
                        node={node}
                        selectedId={selectedSessionId}
                        onSelect={handleSelect}
                      />
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
