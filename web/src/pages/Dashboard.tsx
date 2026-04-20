import { cn } from '../lib/utils'

// ─── Mock Data ────────────────────────────────────────────────────────────

const ROLES = [
  { type: 'pm', label: '项目经理', occupant: 'PM Agent', kind: 'agent' as const, level: 3, active: true },
  { type: 'developer', label: '研发工程师', occupant: 'Alice', kind: 'human' as const, level: 4, active: true },
  { type: 'qa', label: '测试工程师', occupant: 'QA Agent', kind: 'agent' as const, level: 2, active: true },
  { type: 'product', label: '产品经理', occupant: 'Product Agent', kind: 'agent' as const, level: 1, active: false },
  { type: 'designer', label: '设计师', occupant: 'Bob', kind: 'human' as const, level: 4, active: false },
  { type: 'devops', label: '运维工程师', occupant: 'DevOps Agent', kind: 'agent' as const, level: 2, active: true },
]

const TASKS = {
  backlog: ['User profile page redesign', 'API rate limiting', 'Mobile responsive fix'],
  ready: ['Sprint retrospective report', 'Database migration script'],
  in_progress: ['Auth token refresh flow', 'Dashboard API endpoint'],
  in_review: ['Search functionality upgrade'],
  testing: ['Payment gateway integration'],
  done: ['Login page refactor', 'CI/CD pipeline setup', 'Error tracking setup'],
}

const EVENTS = [
  { time: '14:32', type: 'git.pr.merged', source: 'Alice', detail: 'PR #42 merged: Auth token refresh', role: 'developer' },
  { time: '14:28', type: 'project.task.status_changed', source: 'PM Agent', detail: 'Task "Auth token refresh" → In Review', role: 'pm' },
  { time: '14:15', type: 'agent.tool_call', source: 'QA Agent', detail: 'Executed TaskRead for verification', role: 'qa' },
  { time: '13:55', type: 'git.commit.pushed', source: 'Alice', detail: 'feat(auth): refresh token endpoint', role: 'developer' },
  { time: '13:40', type: 'system.ci.passed', source: 'System', detail: 'CI pipeline passed for branch feat/auth', role: 'devops' },
  { time: '13:20', type: 'project.blocker.detected', source: 'PM Agent', detail: 'Task "DB migration" blocked by infra issue', role: 'pm' },
  { time: '12:00', type: 'team.role.switched', source: 'System', detail: 'QA slot: QA Agent → Bob (manual)', role: 'qa' },
]

// ─── Component ────────────────────────────────────────────────────────────

export function Dashboard() {
  const agentCount = ROLES.filter(r => r.kind === 'agent').length
  const humanCount = ROLES.filter(r => r.kind === 'human').length
  const activeTasks = Object.values(TASKS).flat().length
  const doneTasks = TASKS.done.length

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Project Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Agent-driven project management — real-time status
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-agent/10 text-agent text-xs font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-agent animate-pulse-slow" />
            {agentCount} Agents Active
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-human/10 text-human text-xs font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-human" />
            {humanCount} Humans
          </span>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Total Tasks" value={String(activeTasks)} sub={`${doneTasks} completed`} />
        <StatCard label="Sprint Progress" value="67%" sub="12 of 18 tasks done" accent />
        <StatCard label="Active Roles" value={String(ROLES.length)} sub={`${agentCount}A / ${humanCount}H`} />
        <StatCard label="Events Today" value="47" sub="7 in last hour" />
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-3 gap-4">
        {/* Roles Overview */}
        <div className="col-span-1 border border-border rounded-lg bg-card p-4">
          <h2 className="text-sm font-medium mb-3 flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-primary" />
            Active Roles
          </h2>
          <div className="space-y-2">
            {ROLES.map(role => (
              <div key={role.type} className="flex items-center justify-between py-1.5 px-2 rounded-md hover:bg-secondary transition-colors">
                <div className="flex items-center gap-2">
                  <span className={cn(
                    'w-2 h-2 rounded-full',
                    role.kind === 'agent' ? 'bg-agent' : 'bg-human',
                    !role.active && 'opacity-40',
                  )} />
                  <span className="text-sm">{role.label}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">{role.occupant}</span>
                  <span className={cn(
                    'text-[10px] font-mono px-1.5 py-0.5 rounded',
                    role.kind === 'agent' ? 'bg-agent/10 text-agent' : 'bg-human/10 text-human',
                  )}>
                    {role.kind === 'agent' ? 'AI' : 'HU'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Task Summary */}
        <div className="col-span-1 border border-border rounded-lg bg-card p-4">
          <h2 className="text-sm font-medium mb-3 flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-success" />
            Task Pipeline
          </h2>
          <div className="space-y-2">
            {Object.entries(TASKS).map(([status, tasks]) => (
              <div key={status} className="flex items-center justify-between py-1">
                <span className="text-xs text-muted-foreground capitalize font-mono">
                  {status.replace('_', ' ')}
                </span>
                <div className="flex items-center gap-2">
                  <div className="w-24 h-1.5 rounded-full bg-secondary overflow-hidden">
                    <div
                      className={cn(
                        'h-full rounded-full',
                        status === 'done' ? 'bg-success' : status === 'in_progress' ? 'bg-primary' : 'bg-muted-foreground/30',
                      )}
                      style={{ width: `${Math.min((tasks.length / activeTasks) * 100, 100)}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono w-5 text-right">{tasks.length}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Event Stream */}
        <div className="col-span-1 border border-border rounded-lg bg-card p-4">
          <h2 className="text-sm font-medium mb-3 flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse-slow" />
            Live Events
          </h2>
          <div className="space-y-1.5 max-h-[320px] overflow-auto">
            {EVENTS.map((evt, i) => (
              <div key={i} className="flex gap-2 py-1.5 px-1 rounded text-xs animate-slide-in" style={{ animationDelay: `${i * 50}ms` }}>
                <span className="text-muted-foreground font-mono w-10 flex-shrink-0">{evt.time}</span>
                <span className={cn(
                  'w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0',
                  evt.source === 'System' ? 'bg-warning' :
                  evt.type.includes('git') ? 'bg-agent' : 'bg-primary',
                )} />
                <div className="min-w-0">
                  <span className="text-foreground">{evt.detail}</span>
                  <span className="text-muted-foreground ml-1">— {evt.source}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: boolean }) {
  return (
    <div className={cn(
      'border border-border rounded-lg bg-card p-4',
      accent && 'glow-primary',
    )}>
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className={cn('text-2xl font-semibold font-mono', accent && 'text-primary')}>{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>
    </div>
  )
}
