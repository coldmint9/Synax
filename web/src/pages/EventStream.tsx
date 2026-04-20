import { useState } from 'react'
import { cn } from '../lib/utils'
import { Filter } from 'lucide-react'

interface Event {
  id: string
  timestamp: string
  type: string
  source: string
  sourceKind: 'agent' | 'human' | 'system'
  detail: string
  rolePerspective: {
    pm: string
    developer: string
    qa: string
    product: string
  }
}

const EVENTS: Event[] = [
  {
    id: 'e1', timestamp: '2026-04-19 14:32:15', type: 'git.pr.merged',
    source: 'Alice', sourceKind: 'human',
    detail: 'PR #42 merged: feat/auth-refresh into main',
    rolePerspective: {
      pm: '✅ 任务 "Auth token refresh" 已完成，Sprint 进度 67%',
      developer: '🔄 分支 feat/auth-refresh 已合并到 main',
      qa: '🧪 新代码已合并，请安排回归测试',
      product: '🚀 认证功能已上线预览环境，可验收',
    },
  },
  {
    id: 'e2', timestamp: '2026-04-19 14:28:03', type: 'project.task.status_changed',
    source: 'PM Agent', sourceKind: 'agent',
    detail: 'Task "Auth token refresh" status → In Review',
    rolePerspective: {
      pm: '📋 任务状态自动更新，进度正常',
      developer: '👀 任务进入 Review 阶段',
      qa: '🧪 即将需要测试验证',
      product: '📊 功能接近完成',
    },
  },
  {
    id: 'e3', timestamp: '2026-04-19 14:15:47', type: 'agent.tool_call',
    source: 'QA Agent', sourceKind: 'agent',
    detail: 'Executed TaskRead for task verification',
    rolePerspective: {
      pm: '📋 QA Agent 正在验证任务状态',
      developer: 'ℹ️ QA 正在检查任务',
      qa: '🔍 执行任务状态读取，准备测试',
      product: 'ℹ️ 质量检查进行中',
    },
  },
  {
    id: 'e4', timestamp: '2026-04-19 13:55:22', type: 'git.commit.pushed',
    source: 'Alice', sourceKind: 'human',
    detail: 'feat(auth): implement refresh token endpoint',
    rolePerspective: {
      pm: '📊 Alice 推送了代码，任务进展正常',
      developer: '💻 新的认证端点代码已推送',
      qa: 'ℹ️ 代码变更，等待 PR 创建',
      product: '📊 开发进展正常',
    },
  },
  {
    id: 'e5', timestamp: '2026-04-19 13:40:11', type: 'system.ci.passed',
    source: 'System', sourceKind: 'system',
    detail: 'CI pipeline passed for branch feat/auth-refresh',
    rolePerspective: {
      pm: '✅ CI 通过，代码质量良好',
      developer: '✅ CI 通过，可以创建 PR',
      qa: '✅ CI 验证通过',
      product: '✅ 自动化检查通过',
    },
  },
  {
    id: 'e6', timestamp: '2026-04-19 13:20:05', type: 'project.blocker.detected',
    source: 'PM Agent', sourceKind: 'agent',
    detail: 'Task "DB migration" blocked by infrastructure issue',
    rolePerspective: {
      pm: '🚨 阻塞检测：数据库迁移被基础设施问题阻塞！需要协调',
      developer: '⚠️ 基础设施问题可能影响你的任务',
      qa: 'ℹ️ 有任务被阻塞，可能影响测试计划',
      product: '⚠️ 部分工作被阻塞，可能影响交付',
    },
  },
  {
    id: 'e7', timestamp: '2026-04-19 12:00:00', type: 'team.role.switched',
    source: 'System', sourceKind: 'system',
    detail: 'QA slot switched: QA Agent → Bob (manual)',
    rolePerspective: {
      pm: '👥 QA 角色已切换为 Bob',
      developer: 'ℹ️ QA 现在由 Bob 负责',
      qa: '🔄 你已接管 QA 角色',
      product: 'ℹ️ QA 人员变更',
    },
  },
]

const ROLE_FILTERS = ['all', 'pm', 'developer', 'qa', 'product'] as const
type RoleFilter = typeof ROLE_FILTERS[number]

const TYPE_COLORS: Record<string, string> = {
  'git.': 'text-agent',
  'project.task': 'text-primary',
  'project.blocker': 'text-destructive',
  'project.sprint': 'text-success',
  'agent.': 'text-agent',
  'system.ci': 'text-warning',
  'team.': 'text-human',
}

export function EventStream() {
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all')
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null)

  return (
    <div className="p-6 space-y-4 h-full flex flex-col">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Event Stream</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Zero-Alignment Protocol — role-based information delivery
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Filter size={12} className="text-muted-foreground" />
          {ROLE_FILTERS.map(role => (
            <button
              key={role}
              onClick={() => setRoleFilter(role)}
              className={cn(
                'text-[10px] font-mono px-2 py-1 rounded-md transition-colors',
                roleFilter === role
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-muted-foreground hover:text-foreground',
              )}
            >
              {role === 'all' ? 'ALL' : role.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 flex gap-4 overflow-hidden">
        {/* Event List */}
        <div className={cn(
          'overflow-auto border border-border rounded-lg bg-card',
          selectedEvent ? 'w-1/2' : 'w-full',
        )}>
          <div className="divide-y divide-border">
            {EVENTS.map(evt => {
              const typeColor = Object.entries(TYPE_COLORS).find(([prefix]) => evt.type.startsWith(prefix))?.[1] ?? 'text-foreground'
              const isRelevant = roleFilter === 'all' || evt.rolePerspective[roleFilter as keyof typeof evt.rolePerspective]

              if (!isRelevant && roleFilter !== 'all') return null

              return (
                <button
                  key={evt.id}
                  onClick={() => setSelectedEvent(evt)}
                  className={cn(
                    'w-full text-left px-4 py-3 hover:bg-secondary transition-colors',
                    selectedEvent?.id === evt.id && 'bg-primary/5 border-l-2 border-l-primary',
                  )}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-mono text-muted-foreground">{evt.timestamp.split(' ')[1]}</span>
                    <span className={cn('text-[10px] font-mono', typeColor)}>{evt.type}</span>
                    <span className={cn(
                      'text-[9px] font-mono px-1 py-0.5 rounded ml-auto',
                      evt.sourceKind === 'agent' ? 'bg-agent/10 text-agent' :
                      evt.sourceKind === 'system' ? 'bg-warning/10 text-warning' :
                      'bg-human/10 text-human',
                    )}>
                      {evt.source}
                    </span>
                  </div>
                  <p className="text-xs text-foreground/80">{evt.detail}</p>
                  {roleFilter !== 'all' && (
                    <p className="text-xs text-primary/70 mt-1 italic">
                      {evt.rolePerspective[roleFilter as keyof typeof evt.rolePerspective]}
                    </p>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* Detail Panel */}
        {selectedEvent && (
          <div className="w-1/2 border border-border rounded-lg bg-card p-5 overflow-auto">
            <h3 className="text-sm font-semibold mb-1">Event Detail</h3>
            <div className="text-xs font-mono text-muted-foreground mb-4">{selectedEvent.type}</div>

            <div className="space-y-4">
              <div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Raw Event</div>
                <p className="text-sm">{selectedEvent.detail}</p>
              </div>

              <div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
                  Role Perspectives (Zero-Alignment)
                </div>
                <div className="space-y-2">
                  {Object.entries(selectedEvent.rolePerspective).map(([role, perspective]) => (
                    <div key={role} className="px-3 py-2 rounded-md bg-secondary">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={cn(
                          'text-[9px] font-mono px-1.5 py-0.5 rounded',
                          role === 'pm' ? 'bg-primary/10 text-primary' :
                          role === 'developer' ? 'bg-agent/10 text-agent' :
                          role === 'qa' ? 'bg-success/10 text-success' :
                          'bg-human/10 text-human',
                        )}>
                          {role.toUpperCase()}
                        </span>
                      </div>
                      <p className="text-xs">{perspective}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
