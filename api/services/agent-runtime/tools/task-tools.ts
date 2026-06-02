import * as z from 'zod/v4';
import type { RegisteredTool } from '../contracts.js';
import { agentEventService } from '../event-service.js';
import { agentRuntimeStore } from '../session-store.js';

const TaskToolEventType = {
  TaskStateUpdated: 'task_state_updated',
} as const;

// ── Data Model ──────────────────────────────────────────────────────────────

export interface Task {
  id: string
  subject: string
  description: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  owner?: string
  blocks: string[]
  blockedBy: string[]
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

// ── TaskStore ───────────────────────────────────────────────────────────────

export class TaskStore {
  private tasks = new Map<string, Task>()
  private nextId = 1

  static fromEvents(sessionId: string): TaskStore {
    const store = new TaskStore()
    const events = agentRuntimeStore.listEvents(sessionId)
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev.type === TaskToolEventType.TaskStateUpdated) {
        const items = ev.payload.tasks as Task[]
        for (const t of items) store.tasks.set(t.id, t)
        store.nextId = (ev.payload.nextId as number) ?? items.length + 1
        return store
      }
    }
    return store
  }

  persist(sessionId: string): void {
    agentEventService.append({
      sessionId,
      type: TaskToolEventType.TaskStateUpdated,
      summary: `Tasks: ${this.summary()}`,
      payload: { tasks: [...this.tasks.values()], nextId: this.nextId },
    })
  }

  create(subject: string, description: string, activeForm?: string): Task {
    const id = String(this.nextId++)
    const now = new Date().toISOString()
    const task: Task = {
      id, subject, description, activeForm,
      status: 'pending', blocks: [], blockedBy: [],
      metadata: {}, createdAt: now, updatedAt: now,
    }
    this.tasks.set(id, task)
    return task
  }

  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId)
  }

  list(): Task[] {
    return [...this.tasks.values()].filter(t => t.status !== 'deleted')
  }

  update(taskId: string, updates: Partial<Pick<Task, 'status' | 'subject' | 'description' | 'activeForm' | 'owner' | 'metadata'>>): Task {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`Task "${taskId}" not found.`)

    if (updates.status === 'in_progress') {
      const openBlockers = task.blockedBy.filter(id => {
        const b = this.tasks.get(id)
        return b && b.status !== 'completed' && b.status !== 'deleted'
      })
      if (openBlockers.length > 0) {
        throw new Error(`Task "${taskId}" is blocked by: ${openBlockers.join(', ')}`)
      }
    }

    if (updates.status) task.status = updates.status
    if (updates.subject) task.subject = updates.subject
    if (updates.description !== undefined) task.description = updates.description
    if (updates.activeForm !== undefined) task.activeForm = updates.activeForm
    if (updates.owner !== undefined) task.owner = updates.owner
    if (updates.metadata) Object.assign(task.metadata, updates.metadata)
    task.updatedAt = new Date().toISOString()
    return task
  }

  addBlocks(taskId: string, targetIds: string[]): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    for (const tid of targetIds) {
      if (!task.blocks.includes(tid)) task.blocks.push(tid)
      const target = this.tasks.get(tid)
      if (target && !target.blockedBy.includes(taskId)) target.blockedBy.push(taskId)
    }
  }

  addBlockedBy(taskId: string, blockerIds: string[]): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    for (const bid of blockerIds) {
      if (!task.blockedBy.includes(bid)) task.blockedBy.push(bid)
      const blocker = this.tasks.get(bid)
      if (blocker && !blocker.blocks.includes(taskId)) blocker.blocks.push(taskId)
    }
  }

  summary(): string {
    const all = this.list()
    const done = all.filter(t => t.status === 'completed').length
    return `${done}/${all.length} completed`
  }
}

// ── Drift Reminder ──────────────────────────────────────────────────────────

const DRIFT_THRESHOLD = 3;

export function buildTaskDriftReminder(sessionId: string): string | null {
  const events = agentRuntimeStore.listEvents(sessionId)
  let lastIdx = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'task_state_updated' || events[i].type === 'todo_updated') {
      lastIdx = i
      break
    }
  }
  if (lastIdx < 0) return null

  const stepsSince = events.slice(lastIdx + 1).filter(e => e.type === 'tool_result').length
  if (stepsSince < DRIFT_THRESHOLD) return null

  const store = TaskStore.fromEvents(sessionId)
  const tasks = store.list()
  const inProgress = tasks.filter(t => t.status === 'in_progress')
  const pending = tasks.filter(t => t.status === 'pending')
  if (inProgress.length === 0 && pending.length === 0) return null

  const current = inProgress.length > 0
    ? `Current: "${inProgress[0].subject}"`
    : `Next pending: "${pending[0].subject}"`
  return `Task list not updated for ${stepsSince} steps. ${current}. ${inProgress.length} in_progress, ${pending.length} pending. Use task.update to mark progress.`
}

// ── Tools ───────────────────────────────────────────────────────────────────

export const taskCreateTool: RegisteredTool = {
  id: 'task.create',
  label: 'Create Task',
  description: 'Create a new task to track work progress.',
  category: 'task',
  internalGate: 'none',
  mutability: 'write',
  resumeBehavior: 'auto',
  inputSchema: z.object({
    subject: z.string().min(1).describe('Brief imperative title, e.g. "Fix auth bug"'),
    description: z.string().describe('What needs to be done'),
    activeForm: z.string().optional().describe('Present continuous form for spinner, e.g. "Fixing auth bug"'),
  }),
  execute(input) {
    const args = input.args as { subject: string; description: string; activeForm?: string }
    const store = TaskStore.fromEvents(input.sessionId)
    const task = store.create(args.subject, args.description, args.activeForm)
    store.persist(input.sessionId)
    return {
      result: task,
      displaySummary: `Created task #${task.id}: ${task.subject}`,
      artifacts: [],
    }
  },
}

export const taskUpdateTool: RegisteredTool = {
  id: 'task.update',
  label: 'Update Task',
  description: 'Update a task status, details, or dependencies.',
  category: 'task',
  internalGate: 'none',
  mutability: 'write',
  resumeBehavior: 'auto',
  inputSchema: z.object({
    taskId: z.string().min(1).describe('Task ID to update'),
    status: z.enum(['pending', 'in_progress', 'completed', 'deleted']).optional(),
    subject: z.string().optional(),
    description: z.string().optional(),
    activeForm: z.string().optional(),
    owner: z.string().optional(),
    addBlocks: z.array(z.string()).optional().describe('Task IDs this task blocks'),
    addBlockedBy: z.array(z.string()).optional().describe('Task IDs that block this task'),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  execute(input) {
    const args = input.args as {
      taskId: string; status?: Task['status']; subject?: string;
      description?: string; activeForm?: string; owner?: string;
      addBlocks?: string[]; addBlockedBy?: string[]; metadata?: Record<string, unknown>;
    }
    const store = TaskStore.fromEvents(input.sessionId)
    const task = store.update(args.taskId, {
      status: args.status, subject: args.subject,
      description: args.description, activeForm: args.activeForm,
      owner: args.owner, metadata: args.metadata,
    })
    if (args.addBlocks) store.addBlocks(args.taskId, args.addBlocks)
    if (args.addBlockedBy) store.addBlockedBy(args.taskId, args.addBlockedBy)
    store.persist(input.sessionId)
    return {
      result: task,
      displaySummary: `Updated task #${task.id}: ${task.status}`,
      artifacts: [],
    }
  },
}

export const taskGetTool: RegisteredTool = {
  id: 'task.get',
  label: 'Get Task',
  description: 'Get full details of a task by ID.',
  category: 'task',
  internalGate: 'none',
  mutability: 'read',
  resumeBehavior: 'auto',
  inputSchema: z.object({
    taskId: z.string().min(1).describe('Task ID to retrieve'),
  }),
  execute(input) {
    const { taskId } = input.args as { taskId: string }
    const store = TaskStore.fromEvents(input.sessionId)
    const task = store.get(taskId)
    if (!task) throw new Error(`Task "${taskId}" not found.`)
    return {
      result: task,
      displaySummary: `Task #${task.id}: ${task.subject} [${task.status}]`,
      artifacts: [],
    }
  },
}

export const taskListTool: RegisteredTool = {
  id: 'task.list',
  label: 'List Tasks',
  description: 'List all active tasks with their status.',
  category: 'task',
  internalGate: 'none',
  mutability: 'read',
  resumeBehavior: 'auto',
  inputSchema: z.object({}),
  execute(input) {
    const store = TaskStore.fromEvents(input.sessionId)
    const tasks = store.list()
    const summary = tasks.map(t =>
      `#${t.id} [${t.status}] ${t.subject}${t.blockedBy.length ? ` (blocked by: ${t.blockedBy.join(',')})` : ''}`
    )
    return {
      result: { tasks, total: tasks.length },
      displaySummary: `${tasks.length} tasks: ${store.summary()}`,
      artifacts: [],
    }
  },
}
