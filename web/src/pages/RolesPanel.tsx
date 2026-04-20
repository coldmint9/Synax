import { useState } from 'react'
import { cn } from '../lib/utils'
import { ArrowLeftRight, Bot, User } from 'lucide-react'

interface RoleSlot {
  id: string
  type: string
  label: string
  description: string
  occupant: { kind: 'agent' | 'human'; name: string; email?: string; model?: string }
  capabilityLevel: number
  switchPolicy: string
}

const LEVEL_LABELS: Record<number, string> = {
  1: 'Observer',
  2: 'Executor',
  3: 'Collaborator',
  4: 'Autonomous',
}

const INITIAL_SLOTS: RoleSlot[] = [
  {
    id: 'slot_pm', type: 'pm', label: '项目经理',
    description: '里程碑规划、资源调度、风险管控、进度汇报',
    occupant: { kind: 'agent', name: 'PM Agent', model: 'claude-sonnet' },
    capabilityLevel: 3, switchPolicy: 'hybrid',
  },
  {
    id: 'slot_dev', type: 'developer', label: '研发工程师',
    description: '代码实现、Code Review、技术方案',
    occupant: { kind: 'human', name: 'Alice', email: 'alice@synapse.dev' },
    capabilityLevel: 4, switchPolicy: 'manual',
  },
  {
    id: 'slot_qa', type: 'qa', label: '测试工程师',
    description: '测试计划、用例编写、缺陷验证',
    occupant: { kind: 'agent', name: 'QA Agent', model: 'claude-sonnet' },
    capabilityLevel: 2, switchPolicy: 'auto_failover',
  },
  {
    id: 'slot_product', type: 'product', label: '产品经理',
    description: '需求定义、用户故事、验收标准',
    occupant: { kind: 'agent', name: 'Product Agent', model: 'claude-haiku' },
    capabilityLevel: 1, switchPolicy: 'hybrid',
  },
  {
    id: 'slot_design', type: 'designer', label: '设计师',
    description: 'UI/UX 设计、交互规范、设计系统',
    occupant: { kind: 'human', name: 'Bob', email: 'bob@synapse.dev' },
    capabilityLevel: 4, switchPolicy: 'manual',
  },
  {
    id: 'slot_devops', type: 'devops', label: '运维工程师',
    description: '部署、监控、基础设施',
    occupant: { kind: 'agent', name: 'DevOps Agent', model: 'claude-sonnet' },
    capabilityLevel: 2, switchPolicy: 'auto_failover',
  },
]

export function RolesPanel() {
  const [slots, setSlots] = useState(INITIAL_SLOTS)
  const [switchLog, setSwitchLog] = useState<Array<{ slot: string; from: string; to: string; time: string }>>([])

  const handleSwitch = (slotId: string) => {
    setSlots(prev => prev.map(slot => {
      if (slot.id !== slotId) return slot
      const newKind = slot.occupant.kind === 'agent' ? 'human' as const : 'agent' as const
      const newOccupant = newKind === 'agent'
        ? { kind: 'agent' as const, name: `${slot.label} Agent`, model: 'claude-sonnet' }
        : { kind: 'human' as const, name: 'New Member', email: '' }
      setSwitchLog(log => [...log, {
        slot: slot.label,
        from: slot.occupant.name,
        to: newOccupant.name,
        time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      }])
      return { ...slot, occupant: newOccupant, capabilityLevel: newKind === 'human' ? 4 : 2 }
    }))
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Role Slots</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Each role can be occupied by a human or an agent — hot-swap anytime
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {slots.map(slot => (
          <div
            key={slot.id}
            className={cn(
              'border border-border rounded-lg bg-card p-5 transition-all duration-200',
              slot.occupant.kind === 'agent' ? 'hover:glow-agent' : 'hover:glow-human',
            )}
          >
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="text-sm font-semibold">{slot.label}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">{slot.description}</p>
              </div>
              <span className={cn(
                'text-[10px] font-mono px-2 py-0.5 rounded-full font-medium',
                slot.occupant.kind === 'agent'
                  ? 'bg-agent/10 text-agent border border-agent/20'
                  : 'bg-human/10 text-human border border-human/20',
              )}>
                {slot.occupant.kind === 'agent' ? 'AI' : 'HU'}
              </span>
            </div>

            {/* Occupant */}
            <div className="flex items-center gap-3 py-3 px-3 rounded-md bg-secondary mb-3">
              {slot.occupant.kind === 'agent' ? (
                <Bot size={20} className="text-agent" />
              ) : (
                <User size={20} className="text-human" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{slot.occupant.name}</div>
                <div className="text-xs text-muted-foreground font-mono">
                  {slot.occupant.kind === 'agent'
                    ? (slot.occupant as { model?: string }).model ?? 'default'
                    : (slot.occupant as { email?: string }).email ?? 'no email'
                  }
                </div>
              </div>
              <div className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                Lv.{slot.capabilityLevel} {LEVEL_LABELS[slot.capabilityLevel]}
              </div>
            </div>

            {/* Controls */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground font-mono">Policy:</span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                  {slot.switchPolicy}
                </span>
              </div>
              <button
                onClick={() => handleSwitch(slot.id)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium
                  border border-border bg-secondary hover:bg-primary/10 hover:text-primary hover:border-primary/30
                  transition-all duration-200"
              >
                <ArrowLeftRight size={12} />
                Swap to {slot.occupant.kind === 'agent' ? 'Human' : 'Agent'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Switch History */}
      {switchLog.length > 0 && (
        <div className="border border-border rounded-lg bg-card p-4">
          <h2 className="text-sm font-medium mb-3">Switch History</h2>
          <div className="space-y-1">
            {switchLog.map((log, i) => (
              <div key={i} className="flex items-center gap-2 text-xs animate-slide-in">
                <span className="font-mono text-muted-foreground">{log.time}</span>
                <span className="text-foreground">{log.slot}</span>
                <span className="text-muted-foreground">:</span>
                <span className="text-human">{log.from}</span>
                <span className="text-muted-foreground">→</span>
                <span className="text-agent">{log.to}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
