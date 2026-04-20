/**
 * Synapse Event Bus
 *
 * Central event system that powers the Zero-Alignment Protocol.
 * Every action in the system emits events, which are then:
 * 1. Logged for audit
 * 2. Forwarded to relevant roles (role-based information delivery)
 * 3. Used to derive project state (Code-First State)
 */

import { type SynapseEvent, type EventId, type ProjectId, EventType } from '../models/types.js'

// ─── Subscriber ───────────────────────────────────────────────────────────

type EventSubscriber = (event: SynapseEvent) => void | Promise<void>

interface Subscription {
  id: string
  subscriber: EventSubscriber
  filter?: (event: SynapseEvent) => boolean
}

// ─── Event Bus ────────────────────────────────────────────────────────────

export class SynapseEventBus {
  private static instance: SynapseEventBus
  private subscriptions: Map<string, Subscription> = new Map()
  private eventLog: SynapseEvent[] = []
  private maxLogSize = 10_000

  private constructor() {}

  static getInstance(): SynapseEventBus {
    if (!SynapseEventBus.instance) {
      SynapseEventBus.instance = new SynapseEventBus()
    }
    return SynapseEventBus.instance
  }

  /**
   * Emit an event to all subscribers.
   * This is the core mechanism of the Zero-Alignment Protocol:
   * every action produces an event that relevant roles receive.
   */
  emit(event: SynapseEvent): void {
    // Log the event
    this.eventLog.push(event)
    if (this.eventLog.length > this.maxLogSize) {
      this.eventLog = this.eventLog.slice(-this.maxLogSize)
    }

    // Notify all matching subscribers
    for (const sub of this.subscriptions.values()) {
      if (sub.filter && !sub.filter(event)) continue
      try {
        const result = sub.subscriber(event)
        if (result instanceof Promise) {
          result.catch(err => console.error('Event subscriber error:', err))
        }
      } catch (err) {
        console.error('Event subscriber error:', err)
      }
    }
  }

  /**
   * Subscribe to events. Optional filter to receive only specific event types.
   */
  subscribe(subscriber: EventSubscriber, filter?: (event: SynapseEvent) => boolean): string {
    const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    this.subscriptions.set(id, { id, subscriber, filter })
    return id
  }

  unsubscribe(id: string): void {
    this.subscriptions.delete(id)
  }

  /**
   * Get events for a specific project.
   */
  getProjectEvents(projectId: ProjectId, limit = 100): SynapseEvent[] {
    return this.eventLog
      .filter(e => e.projectId === projectId)
      .slice(-limit)
  }

  /**
   * Get events of a specific type.
   */
  getEventsByType(type: EventType, limit = 100): SynapseEvent[] {
    return this.eventLog
      .filter(e => e.type === type)
      .slice(-limit)
  }

  /**
   * Get all events (for audit/debug).
   */
  getAllEvents(limit = 1000): SynapseEvent[] {
    return this.eventLog.slice(-limit)
  }

  /**
   * Clear all events (for testing).
   */
  clear(): void {
    this.eventLog = []
  }
}

// ─── Zero-Alignment Protocol ──────────────────────────────────────────────

/**
 * The InformationBroker implements the Zero-Alignment Protocol:
 * it reframes events for each role's perspective and delivers only
 * what's relevant.
 */
export class InformationBroker {
  private eventBus: SynapseEventBus

  constructor() {
    this.eventBus = SynapseEventBus.getInstance()
  }

  /**
   * Subscribe a role to receive reframed events.
   * Each role gets a personalized view of the same event.
   */
  subscribeRole(
    roleType: string,
    callback: (reframed: ReframedEvent) => void,
  ): string {
    return this.eventBus.subscribe(
      (event) => {
        const reframed = this.reframe(event, roleType)
        if (reframed) callback(reframed)
      },
      (event) => this.isRelevant(event, roleType),
    )
  }

  /**
   * Check if an event is relevant to a specific role.
   */
  private isRelevant(event: SynapseEvent, roleType: string): boolean {
    const relevanceMap: Record<string, EventType[]> = {
      pm: [
        EventType.TaskStatusChanged, EventType.SprintStarted, EventType.SprintCompleted,
        EventType.MilestoneApproaching, EventType.BlockerDetected, EventType.PrMerged,
        EventType.WorkloadThresholdExceeded, EventType.RoleSwitched,
      ],
      developer: [
        EventType.PrOpened, EventType.PrReviewed, EventType.PrMerged,
        EventType.CommitPushed, EventType.CiFailed, EventType.CiPassed,
        EventType.TaskAssigned, EventType.TaskStatusChanged,
      ],
      qa: [
        EventType.PrMerged, EventType.CiFailed, EventType.CiPassed,
        EventType.TaskStatusChanged, EventType.DeploySucceeded,
      ],
      product: [
        EventType.SprintCompleted, EventType.MilestoneApproaching,
        EventType.TaskStatusChanged, EventType.DeploySucceeded,
      ],
      designer: [
        EventType.TaskAssigned, EventType.PrOpened,
      ],
      devops: [
        EventType.CiFailed, EventType.DeployFailed, EventType.DeploySucceeded,
        EventType.PrMerged,
      ],
    }

    const relevantTypes = relevanceMap[roleType] ?? []
    return relevantTypes.includes(event.type) || event.type.startsWith('system.')
  }

  /**
   * Reframe an event for a specific role's perspective.
   * The same event means different things to different roles.
   */
  private reframe(event: SynapseEvent, roleType: string): ReframedEvent | null {
    const reframers: Record<string, (event: SynapseEvent) => ReframedEvent> = {
      pm: (e) => ({
        originalEvent: e,
        title: this.pmTitle(e),
        summary: this.pmSummary(e),
        actionRequired: this.pmActionRequired(e),
        urgency: this.pmUrgency(e),
      }),
      developer: (e) => ({
        originalEvent: e,
        title: this.devTitle(e),
        summary: this.devSummary(e),
        actionRequired: this.devActionRequired(e),
        urgency: this.devUrgency(e),
      }),
      qa: (e) => ({
        originalEvent: e,
        title: this.qaTitle(e),
        summary: this.qaSummary(e),
        actionRequired: this.qaActionRequired(e),
        urgency: this.qaUrgency(e),
      }),
      product: (e) => ({
        originalEvent: e,
        title: this.prodTitle(e),
        summary: this.prodSummary(e),
        actionRequired: this.prodActionRequired(e),
        urgency: this.prodUrgency(e),
      }),
    }

    const reframer = reframers[roleType]
    return reframer ? reframer(event) : null
  }

  // PM perspective
  private pmTitle(e: SynapseEvent): string {
    if (e.type === EventType.BlockerDetected) return '🚨 阻塞项检测'
    if (e.type === EventType.MilestoneApproaching) return '📅 里程碑临近'
    if (e.type === EventType.SprintCompleted) return '✅ Sprint 完成'
    if (e.type === EventType.WorkloadThresholdExceeded) return '⚡ 工作负载超限'
    return '📋 项目更新'
  }
  private pmSummary(e: SynapseEvent): string {
    return `Event ${e.type} from ${e.source}: ${JSON.stringify(e.payload).slice(0, 200)}`
  }
  private pmActionRequired(e: SynapseEvent): string | null {
    if (e.type === EventType.BlockerDetected) return '需要协调解决阻塞'
    if (e.type === EventType.WorkloadThresholdExceeded) return '考虑重新分配任务'
    return null
  }
  private pmUrgency(e: SynapseEvent): 'low' | 'medium' | 'high' {
    if (e.type === EventType.BlockerDetected) return 'high'
    if (e.type === EventType.MilestoneApproaching) return 'medium'
    return 'low'
  }

  // Developer perspective
  private devTitle(e: SynapseEvent): string {
    if (e.type === EventType.PrReviewed) return '👀 PR 收到 Review'
    if (e.type === EventType.CiFailed) return '❌ CI 构建失败'
    if (e.type === EventType.TaskAssigned) return '📌 新任务分配'
    return '🔄 代码活动更新'
  }
  private devSummary(e: SynapseEvent): string { return this.pmSummary(e) }
  private devActionRequired(e: SynapseEvent): string | null {
    if (e.type === EventType.PrReviewed) return '请查看 Review 意见'
    if (e.type === EventType.CiFailed) return '请修复 CI 失败'
    return null
  }
  private devUrgency(e: SynapseEvent): 'low' | 'medium' | 'high' {
    if (e.type === EventType.CiFailed) return 'high'
    if (e.type === EventType.PrReviewed) return 'medium'
    return 'low'
  }

  // QA perspective
  private qaTitle(e: SynapseEvent): string {
    if (e.type === EventType.PrMerged) return '🧪 PR 已合并，请安排测试'
    if (e.type === EventType.CiFailed) return '❌ CI 失败'
    return '🧪 测试更新'
  }
  private qaSummary(e: SynapseEvent): string { return this.pmSummary(e) }
  private qaActionRequired(e: SynapseEvent): string | null {
    if (e.type === EventType.PrMerged) return '安排回归测试'
    return null
  }
  private qaUrgency(e: SynapseEvent): 'low' | 'medium' | 'high' {
    if (e.type === EventType.PrMerged) return 'medium'
    return 'low'
  }

  // Product perspective
  private prodTitle(e: SynapseEvent): string {
    if (e.type === EventType.SprintCompleted) return '🏁 Sprint 完成'
    if (e.type === EventType.DeploySucceeded) return '🚀 功能已部署'
    return '📊 项目进展'
  }
  private prodSummary(e: SynapseEvent): string { return this.pmSummary(e) }
  private prodActionRequired(e: SynapseEvent): string | null {
    if (e.type === EventType.DeploySucceeded) return '可以进行验收'
    return null
  }
  private prodUrgency(e: SynapseEvent): 'low' | 'medium' | 'high' {
    if (e.type === EventType.DeploySucceeded) return 'medium'
    return 'low'
  }
}

export interface ReframedEvent {
  originalEvent: SynapseEvent
  title: string
  summary: string
  actionRequired: string | null
  urgency: 'low' | 'medium' | 'high'
}
