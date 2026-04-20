import { useState, useEffect, useCallback } from 'react'
import { cn } from './lib/utils'
import { WorkspaceView } from './pages/WorkspaceView'
import { WikiPage } from './pages/WikiPage'
import { ArchitecturePage } from './pages/ArchitecturePage'
import { RequirementsPage } from './pages/RequirementsPage'
import {
  Zap, Search, Command, BookOpen, Layers, FileText,
  LayoutDashboard, ChevronDown, Bot, Plus,
} from 'lucide-react'

type Space = 'workspace' | 'wiki' | 'architecture' | 'requirements'
type CommandPaletteMode = 'closed' | 'search' | 'create'

const SPACES: { id: Space; label: string; icon: React.ReactNode; color: string }[] = [
  { id: 'workspace', label: 'Workspace', icon: <LayoutDashboard size={16} />, color: 'text-primary' },
  { id: 'wiki', label: 'Wiki', icon: <BookOpen size={16} />, color: 'text-wiki' },
  { id: 'architecture', label: 'Architecture', icon: <Layers size={16} />, color: 'text-arch' },
  { id: 'requirements', label: 'Requirements', icon: <FileText size={16} />, color: 'text-req' },
]

export default function App() {
  const [space, setSpace] = useState<Space>('workspace')
  const [cmdPalette, setCmdPalette] = useState<CommandPaletteMode>('closed')
  const [cmdQuery, setCmdQuery] = useState('')
  const [agentPanelOpen, setAgentPanelOpen] = useState(false)

  // Cmd+K to open command palette
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setCmdPalette(prev => prev === 'closed' ? 'search' : 'closed')
        setCmdQuery('')
      }
      if (e.key === 'Escape') setCmdPalette('closed')
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const COMMANDS = [
    { label: 'Go to Wiki', action: () => { setSpace('wiki'); setCmdPalette('closed') }, icon: <BookOpen size={14} />, color: 'text-wiki' },
    { label: 'Go to Architecture', action: () => { setSpace('architecture'); setCmdPalette('closed') }, icon: <Layers size={14} />, color: 'text-arch' },
    { label: 'Go to Requirements', action: () => { setSpace('requirements'); setCmdPalette('closed') }, icon: <FileText size={14} />, color: 'text-req' },
    { label: 'Go to Workspace', action: () => { setSpace('workspace'); setCmdPalette('closed') }, icon: <LayoutDashboard size={14} />, color: 'text-primary' },
    { label: 'New Wiki Page', action: () => { setSpace('wiki'); setCmdPalette('closed') }, icon: <Plus size={14} />, color: 'text-wiki' },
    { label: 'New Requirement', action: () => { setSpace('requirements'); setCmdPalette('closed') }, icon: <Plus size={14} />, color: 'text-req' },
    { label: 'New ADR', action: () => { setSpace('architecture'); setCmdPalette('closed') }, icon: <Plus size={14} />, color: 'text-arch' },
  ]

  const filteredCommands = cmdQuery
    ? COMMANDS.filter(c => c.label.toLowerCase().includes(cmdQuery.toLowerCase()))
    : COMMANDS

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Left Rail — Slim icon rail */}
      <aside className="w-12 flex-shrink-0 border-r border-border flex flex-col items-center py-3 gap-1">
        <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center mb-4">
          <Zap size={13} className="text-primary-foreground" />
        </div>

        {SPACES.map(s => (
          <button
            key={s.id}
            onClick={() => setSpace(s.id)}
            className={cn(
              'w-8 h-8 rounded-md flex items-center justify-center transition-all',
              space === s.id
                ? cn('bg-primary/10', s.color)
                : 'text-muted-foreground hover:text-foreground hover:bg-secondary',
            )}
            title={s.label}
          >
            {s.icon}
          </button>
        ))}

        <div className="flex-1" />

        <button
          onClick={() => setCmdPalette(prev => prev === 'closed' ? 'search' : 'closed')}
          className="w-8 h-8 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          title="Command Palette (⌘K)"
        >
          <Command size={14} />
        </button>

        <button
          onClick={() => setAgentPanelOpen(!agentPanelOpen)}
          className={cn(
            'w-8 h-8 rounded-md flex items-center justify-center transition-colors relative',
            agentPanelOpen ? 'bg-agent/10 text-agent' : 'text-muted-foreground hover:text-foreground hover:bg-secondary',
          )}
          title="Agent Panel"
        >
          <Bot size={14} />
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-agent animate-pulse" />
        </button>
      </aside>

      {/* Main Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Content */}
        <main className="flex-1 overflow-auto">
          {space === 'workspace' && <WorkspaceView />}
          {space === 'wiki' && <WikiPage />}
          {space === 'architecture' && <ArchitecturePage />}
          {space === 'requirements' && <RequirementsPage />}
        </main>

        {/* Agent Side Panel (collapsible) */}
        {agentPanelOpen && (
          <aside className="w-80 flex-shrink-0 border-l border-border flex flex-col bg-card">
            <div className="h-11 flex items-center justify-between px-4 border-b border-border">
              <div className="flex items-center gap-2">
                <Bot size={14} className="text-agent" />
                <span className="text-xs font-medium">Agent Context</span>
              </div>
              <button onClick={() => setAgentPanelOpen(false)} className="text-muted-foreground hover:text-foreground text-xs">✕</button>
            </div>
            <AgentContextPanel space={space} />
          </aside>
        )}
      </div>

      {/* Command Palette Overlay */}
      {cmdPalette !== 'closed' && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={() => setCmdPalette('closed')}>
          <div
            className="w-full max-w-lg bg-card border border-border rounded-xl shadow-2xl overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 h-11 border-b border-border">
              <Search size={14} className="text-muted-foreground" />
              <input
                autoFocus
                value={cmdQuery}
                onChange={e => setCmdQuery(e.target.value)}
                placeholder="Search commands, pages, requirements..."
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              <kbd className="text-[10px] font-mono text-muted-foreground border border-border px-1.5 py-0.5 rounded">ESC</kbd>
            </div>
            <div className="max-h-80 overflow-auto py-2">
              {filteredCommands.map((cmd, i) => (
                <button
                  key={i}
                  onClick={cmd.action}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-secondary transition-colors text-left"
                >
                  <span className={cn('flex-shrink-0', cmd.color)}>{cmd.icon}</span>
                  <span className="text-sm">{cmd.label}</span>
                </button>
              ))}
              {filteredCommands.length === 0 && (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No commands matching "{cmdQuery}"
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Agent Context Panel ──────────────────────────────────────────────────

function AgentContextPanel({ space }: { space: Space }) {
  const spaceInfo: Record<Space, { title: string; agent: string; insight: string }> = {
    workspace: {
      title: 'Project Overview',
      agent: 'PM Agent',
      insight: 'Sprint 进度 67%，1个阻塞项需关注。数据库迁移被基础设施问题阻塞，建议安排 DevOps Agent 处理。',
    },
    wiki: {
      title: 'Wiki Auto-Sync',
      agent: 'Wiki Agent',
      insight: '检测到 3 个 PR 合并后文档未更新。API 文档需要同步最新的认证端点变更。',
    },
    architecture: {
      title: 'Architecture Guard',
      agent: 'Arch Agent',
      insight: 'ADR-005 与当前实现存在偏差：认证模块实际使用了 JWT 而非 ADR 中记录的 Session 方案。建议更新 ADR。',
    },
    requirements: {
      title: 'Requirements Tracker',
      agent: 'Product Agent',
      insight: 'REQ-003 "用户权限管理" 缺少验收标准。REQ-007 优先级建议从 Medium 调整为 High（客户反馈量增加 200%）。',
    },
  }

  const info = spaceInfo[space]

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      <div className="px-3 py-2 rounded-lg bg-agent/5 border border-agent/10">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-agent animate-pulse" />
          <span className="text-xs font-medium text-agent">{info.agent}</span>
        </div>
        <p className="text-xs text-foreground/80 leading-relaxed">{info.insight}</p>
      </div>

      <div>
        <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">Suggested Actions</div>
        <div className="space-y-1.5">
          {space === 'workspace' && (
            <>
              <SuggestedAction label="Resolve DB migration blocker" role="DevOps Agent" />
              <SuggestedAction label="Re-prioritize Sprint backlog" role="PM Agent" />
              <SuggestedAction label="Generate daily summary" role="PM Agent" />
            </>
          )}
          {space === 'wiki' && (
            <>
              <SuggestedAction label="Sync API docs from PR #42" role="Wiki Agent" />
              <SuggestedAction label="Generate onboarding guide" role="Wiki Agent" />
              <SuggestedAction label="Update architecture overview" role="Arch Agent" />
            </>
          )}
          {space === 'architecture' && (
            <>
              <SuggestedAction label="Update ADR-005 auth decision" role="Arch Agent" />
              <SuggestedAction label="Generate component diagram" role="Arch Agent" />
              <SuggestedAction label="Review tech stack alignment" role="Arch Agent" />
            </>
          )}
          {space === 'requirements' && (
            <>
              <SuggestedAction label="Add acceptance criteria to REQ-003" role="Product Agent" />
              <SuggestedAction label="Re-prioritize REQ-007" role="Product Agent" />
              <SuggestedAction label="Generate user story map" role="Product Agent" />
            </>
          )}
        </div>
      </div>

      <div>
        <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">Trace Links</div>
        <div className="space-y-1">
          {space === 'wiki' && (
            <>
              <TraceLink label="REQ-003 → Wiki: 权限系统" type="req" />
              <TraceLink label="ADR-005 → Wiki: 认证方案" type="arch" />
              <TraceLink label="T5 (Auth) → Wiki: API 参考" type="task" />
            </>
          )}
          {space === 'architecture' && (
            <>
              <TraceLink label="REQ-001 → ADR-001 前端选型" type="req" />
              <TraceLink label="REQ-003 → ADR-005 认证方案" type="req" />
              <TraceLink label="T5 (Auth) → comp: AuthModule" type="task" />
            </>
          )}
          {space === 'requirements' && (
            <>
              <TraceLink label="REQ-003 → ADR-005" type="arch" />
              <TraceLink label="REQ-001 → T1, T2, T3" type="task" />
              <TraceLink label="REQ-007 → Milestone M2" type="task" />
            </>
          )}
          {space === 'workspace' && (
            <>
              <TraceLink label="REQ-003 → T5, T8" type="req" />
              <TraceLink label="ADR-005 → T5 (mismatch)" type="arch" />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function SuggestedAction({ label, role }: { label: string; role: string }) {
  return (
    <button className="w-full text-left px-3 py-2 rounded-md bg-secondary hover:bg-primary/10 hover:text-primary transition-colors">
      <div className="text-xs">{label}</div>
      <div className="text-[10px] text-muted-foreground font-mono mt-0.5">→ {role}</div>
    </button>
  )
}

function TraceLink({ label, type }: { label: string; type: string }) {
  const colors: Record<string, string> = {
    req: 'text-req',
    arch: 'text-arch',
    task: 'text-primary',
    wiki: 'text-wiki',
  }
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 text-xs">
      <span className={cn('w-1 h-1 rounded-full', colors[type] ?? 'text-muted-foreground')} style={{ backgroundColor: 'currentColor' }} />
      <span className="text-muted-foreground">{label}</span>
    </div>
  )
}
