import { nanoid } from "nanoid";
import {
  taskNotificationBus,
  type TaskLifecycleNotificationType,
  type TaskLifecycleNotificationEvent,
} from "./task-notification-bus.js";
import { logger } from "../../lib/logger.js";

interface NotifyOptions {
  type: TaskLifecycleNotificationType;
  taskKind: string;
  projectId: string;
  taskId: string;
  title: string;
  message: string;
  severity: TaskLifecycleNotificationEvent["severity"];
  meta?: Record<string, unknown>;
}

export function notify(opts: NotifyOptions): void {
  try {
    taskNotificationBus.emit({
      id: nanoid(12),
      timestamp: Date.now(),
      ...opts,
    });
  } catch (err) {
    logger.warn({ err }, "task-notification-bus: emit failed");
  }
}
