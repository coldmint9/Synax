/**
 * Synapse Code-First State Engine
 *
 * Derives project state from real Git activity rather than manual updates.
 * When code changes happen, tasks, milestones, and sprint progress are
 * automatically updated based on configurable mapping rules.
 */

import { type ProjectId, type RoleSlotId, TaskStatus, EventType, type SynapseEvent } from '../models/types.js'
import { SynapseEventBus } from './event-bus.js'

// ─── State Derivation Rules ───────────────────────────────────────────────

interface DerivationRule {
  trigger: EventType
  derive: (event: SynapseEvent, context: DerivationContext) => StateChange[]
}

interface DerivationContext {
  projectId: ProjectId
  sourceRole: RoleSlotId
}

interface StateChange {
  type: 'task_status' | 'milestone_progress' | 'sprint_velocity' | 'risk_level'
  targetId: string
  oldValue: string
  newValue: string
  reason: string
  confidence: number
}

// ─── Built-in Derivation Rules ────────────────────────────────────────────

const DERIVATION_RULES: DerivationRule[] = [
  // Branch created → task moves to "In Progress"
  {
    trigger: EventType.BranchCreated,
    derive: (event, ctx) => {
      const branchName = (event.payload.branchName as string) ?? ''
      const taskMatch = branchName.match(/(?:PROJ|TASK|FEAT)-(\d+)/i)
      if (!taskMatch) return []

      return [{
        type: 'task_status',
        targetId: taskMatch[1],
        oldValue: TaskStatus.Ready,
        newValue: TaskStatus.InProgress,
        reason: `Branch ${branchName} created`,
        confidence: 0.85,
      }]
    },
  },

  // PR opened → task moves to "In Review"
  {
    trigger: EventType.PrOpened,
    derive: (event, ctx) => {
      const branchName = (event.payload.branchName as string) ?? ''
      const taskMatch = branchName.match(/(?:PROJ|TASK|FEAT)-(\d+)/i)
      if (!taskMatch) return []

      return [{
        type: 'task_status',
        targetId: taskMatch[1],
        oldValue: TaskStatus.InProgress,
        newValue: TaskStatus.InReview,
        reason: `PR opened from branch ${branchName}`,
        confidence: 0.9,
      }]
    },
  },

  // PR merged → task moves to "Testing"
  {
    trigger: EventType.PrMerged,
    derive: (event, ctx) => {
      const branchName = (event.payload.branchName as string) ?? ''
      const taskMatch = branchName.match(/(?:PROJ|TASK|FEAT)-(\d+)/i)
      if (!taskMatch) return []

      return [{
        type: 'task_status',
        targetId: taskMatch[1],
        oldValue: TaskStatus.InReview,
        newValue: TaskStatus.Testing,
        reason: `PR merged from branch ${branchName}`,
        confidence: 0.95,
      }]
    },
  },

  // Commit pushed → update last activity timestamp
  {
    trigger: EventType.CommitPushed,
    derive: (event, ctx) => {
      return [{
        type: 'task_status',
        targetId: 'last_activity',
        oldValue: '',
        newValue: new Date(event.timestamp).toISOString(),
        reason: 'Code activity detected',
        confidence: 1.0,
      }]
    },
  },

  // CI failed → risk level increase
  {
    trigger: EventType.CiFailed,
    derive: (event, ctx) => {
      return [{
        type: 'risk_level',
        targetId: ctx.projectId,
        oldValue: 'low',
        newValue: 'high',
        reason: 'CI pipeline failed',
        confidence: 0.9,
      }]
    },
  },

  // Sprint completed → calculate velocity
  {
    trigger: EventType.SprintCompleted,
    derive: (event, ctx) => {
      return [{
        type: 'sprint_velocity',
        targetId: ctx.projectId,
        oldValue: '',
        newValue: String(event.payload.completedTasks ?? 0),
        reason: 'Sprint completed',
        confidence: 1.0,
      }]
    },
  },
]

// ─── State Engine ─────────────────────────────────────────────────────────

export class CodeFirstStateEngine {
  private eventBus: SynapseEventBus
  private rules: DerivationRule[]
  private stateChanges: StateChange[] = []
  private maxChanges = 1000

  constructor(customRules?: DerivationRule[]) {
    this.eventBus = SynapseEventBus.getInstance()
    this.rules = [...DERIVATION_RULES, ...(customRules ?? [])]

    // Subscribe to all events and derive state
    this.eventBus.subscribe(
      (event) => this.processEvent(event),
    )
  }

  private processEvent(event: SynapseEvent): void {
    const matchingRules = this.rules.filter(r => r.trigger === event.type)

    for (const rule of matchingRules) {
      const changes = rule.derive(event, {
        projectId: event.projectId,
        sourceRole: event.source,
      })

      for (const change of changes) {
        this.stateChanges.push(change)

        // Keep log bounded
        if (this.stateChanges.length > this.maxChanges) {
          this.stateChanges = this.stateChanges.slice(-this.maxChanges)
        }

        // Emit derived state change as a new event
        this.eventBus.emit({
          id: `derived_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: EventType.TaskStatusChanged,
          timestamp: Date.now(),
          projectId: event.projectId,
          source: 'system:code_first',
          payload: {
            derivedFrom: event.id,
            changeType: change.type,
            targetId: change.targetId,
            oldValue: change.oldValue,
            newValue: change.newValue,
            reason: change.reason,
            confidence: change.confidence,
          },
        })
      }
    }
  }

  getStateChanges(projectId?: ProjectId, limit = 100): StateChange[] {
    const changes = projectId
      ? this.stateChanges.filter(c => c.targetId.startsWith(projectId))
      : this.stateChanges
    return changes.slice(-limit)
  }

  addRule(rule: DerivationRule): void {
    this.rules.push(rule)
  }
}
