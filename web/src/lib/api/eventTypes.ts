export const TaskNotificationEventType = {
  TaskStarted: 'task_started',
  TaskProgress: 'task_progress',
  TaskCompleted: 'task_completed',
  TaskFailed: 'task_failed',
  WikiSnapshot: 'wiki_snapshot',
} as const

export type TaskNotificationEventType =
  (typeof TaskNotificationEventType)[keyof typeof TaskNotificationEventType]

export const SseEventType = {
  Connected: 'connected',
  Ping: 'ping',
  Ready: 'ready',
} as const

export type SseEventType = (typeof SseEventType)[keyof typeof SseEventType]
