import { EventEmitter } from "node:events";

export type TaskNotificationType =
  | "task_started"
  | "task_progress"
  | "task_completed"
  | "task_failed";

export interface TaskNotificationEvent {
  id: string;
  type: TaskNotificationType;
  taskKind: string;
  projectId: string;
  taskId: string;
  title: string;
  message: string;
  severity: "info" | "success" | "warning" | "error";
  timestamp: number;
  meta?: Record<string, unknown>;
}

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

  subscribeAll(
    handler: (event: TaskNotificationEvent) => void,
  ): () => void {
    this.emitter.on("*", handler);
    return () => {
      this.emitter.off("*", handler);
    };
  }
}

export const taskNotificationBus = new TaskNotificationBus();
