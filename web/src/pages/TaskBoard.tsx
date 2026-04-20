import { useState } from 'react'
import { cn } from '../lib/utils'
import { GitBranch } from 'lucide-react'

interface Task {
  id: string
  title: string
  status: string
  assignee: string
  assigneeKind: 'agent' | 'human'
  priority: 'critical' | 'high' | 'medium' | 'low'
  gitBranch?: string
  derived: boolean
}

const COLUMNS = [
  { id: 'backlog', label: 'Backlog', color: 'bg-muted-foreground/20' },
  { id: 'ready', label: 'Ready', color: 'bg-primary/30' },
  { id: 'in_progress', label: 'In Progress', color: 'bg-primary' },
  { id: 'in_review', label: 'In Review', color: 'bg-agent' },
  { id: 'testing', label: 'Testing', color: 'bg-warning' },
  { id: 'done', label: 'Done', color: 'bg-success' },
]

const INITIAL_TASKS: Task[] = [
  { id: 'T1', title: 'User profile page redesign', status: 'backlog', assignee: 'Bob', assigneeKind: 'human', priority: 'medium', derived: false },
  { id: 'T2', title: 'API rate limiting middleware', status: 'backlog', assignee: 'Dev Agent', assigneeKind: 'agent', priority: 'low', derived: false },
  { id: 'T3', title: 'Sprint retrospective report', status: 'ready', assignee: 'PM Agent', assigneeKind: 'agent', priority: 'medium', derived: false },
  { id: 'T4', title: 'Database migration script', status: 'ready', assignee: 'Dev Agent', assigneeKind: 'agent', priority: 'high', derived: false },
  { id: 'T5', title: 'Auth token refresh flow', status: 'in_progress', assignee: 'Alice', assigneeKind: 'human', priority: 'critical', gitBranch: 'feat/auth-refresh', derived: true },
  { id: 'T6', title: 'Dashboard API endpoint', status: 'in_progress', assignee: 'Dev Agent', assigneeKind: 'agent', priority: 'high', gitBranch: 'feat/dashboard-api', derived: true },
  { id: 'T7', title: 'Search functionality upgrade', status: 'in_review', assignee: 'Alice', assigneeKind: 'human', priority: 'high', gitBranch: 'feat/search-v2', derived: true },
  { id: 'T8', title: 'Payment gateway integration', status: 'testing', assignee: 'QA Agent', assigneeKind: 'agent', priority: 'critical', derived: true },
  { id: 'T9', title: 'Login page refactor', status: 'done', assignee: 'Alice', assigneeKind: 'human', priority: 'high', derived: true },
  { id: 'T10', title: 'CI/CD pipeline setup', status: 'done', assignee: 'DevOps Agent', assigneeKind: 'agent', priority: 'high', derived: true },
  { id: 'T11', title: 'Error tracking integration', status: 'done', assignee: 'DevOps Agent', assigneeKind: 'agent', priority: 'medium', derived: true },
]

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'bg-destructive text-destructive-foreground',
  high: 'bg-warning/20 text-warning',
  medium: 'bg-primary/20 text-primary',
  low: 'bg-muted text-muted-foreground',
}

export function TaskBoard() {
  const [tasks] = useState(INITIAL_TASKS)

  return (
    <div className="p-6 space-y-4 h-full flex flex-col">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Task Board</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Status auto-derived from Git activity
            <span className="inline-flex items-center gap-1 ml-2 text-[10px] font-mono px-1.5 py-0.5 rounded bg-agent/10 text-agent">
              <GitBranch size={10} /> Code-First State
            </span>
          </p>
        </div>
        <button className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
          + New Task
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="flex gap-3 min-h-0">
          {COLUMNS.map(col => {
            const colTasks = tasks.filter(t => t.status === col.id)
            return (
              <div key={col.id} className="flex-1 min-w-[200px]">
                {/* Column Header */}
                <div className="flex items-center gap-2 mb-3 px-1">
                  <span className={cn('w-2 h-2 rounded-full', col.color)} />
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    {col.label}
                  </span>
                  <span className="text-[10px] font-mono text-muted-foreground ml-auto">
                    {colTasks.length}
                  </span>
                </div>

                {/* Cards */}
                <div className="space-y-2">
                  {colTasks.map(task => (
                    <div
                      key={task.id}
                      className="border border-border rounded-lg bg-card p-3 hover:border-primary/30 transition-all duration-150 cursor-pointer"
                    >
                      <div className="flex items-start justify-between mb-2">
                        <span className="text-[10px] font-mono text-muted-foreground">{task.id}</span>
                        <span className={cn('text-[9px] font-mono px-1.5 py-0.5 rounded', PRIORITY_COLORS[task.priority])}>
                          {task.priority}
                        </span>
                      </div>
                      <p className="text-sm leading-snug mb-2">{task.title}</p>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <span className={cn(
                            'w-1.5 h-1.5 rounded-full',
                            task.assigneeKind === 'agent' ? 'bg-agent' : 'bg-human',
                          )} />
                          <span className="text-[11px] text-muted-foreground">{task.assignee}</span>
                        </div>
                        {task.gitBranch && (
                          <span className="text-[10px] font-mono text-agent/70 flex items-center gap-0.5">
                            <GitBranch size={9} />
                            {task.gitBranch.replace('feat/', '')}
                          </span>
                        )}
                        {task.derived && (
                          <span className="text-[8px] font-mono px-1 py-0.5 rounded bg-agent/5 text-agent/60 border border-agent/10">
                            AUTO
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
