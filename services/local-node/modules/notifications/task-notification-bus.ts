import { EventEmitter } from "node:events";
import { SseEventType } from "../../infrastructure/runtime/sse-events.js";

export const TaskNotificationEventType = {
  TaskStarted: "task_started",
  TaskProgress: "task_progress",
  TaskCompleted: "task_completed",
  TaskFailed: "task_failed",
} as const;

export const NotificationStreamEventType = {
  Connected: SseEventType.Connected,
  Ping: SseEventType.Ping,
} as const;

export type TaskLifecycleNotificationType =
  | typeof TaskNotificationEventType.TaskStarted
  | typeof TaskNotificationEventType.TaskProgress
  | typeof TaskNotificationEventType.TaskCompleted
  | typeof TaskNotificationEventType.TaskFailed;

export type TaskNotificationType = TaskLifecycleNotificationType;

export interface TaskLifecycleNotificationEvent {
  id: string;
  type: TaskLifecycleNotificationType;
  taskKind: string;
  projectId: string;
  taskId: string;
  title: string;
  message: string;
  severity: "info" | "success" | "warning" | "error";
  timestamp: number;
  meta?: Record<string, unknown>;
}

export type TaskNotificationEvent = TaskLifecycleNotificationEvent;

class TaskNotificationBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(event: TaskNotificationEvent): void {
    this.emitter.emit(`project:${event.projectId}`, event);
    this.emitter.emit("*", event);
  }

  subscribe(
    projectId: string,
    handler: (event: TaskNotificationEvent) => void,
  ): () => void {
    const channel = `project:${projectId}`;
    this.emitter.on(channel, handler);
    return () => {
      this.emitter.off(channel, handler);
    };
  }
}

export const taskNotificationBus = new TaskNotificationBus();
