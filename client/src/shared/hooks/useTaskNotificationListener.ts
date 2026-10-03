import { useEffect } from "react";
import {
  useNotificationStore,
  type NotificationType,
} from "../state/notificationStore";
import { subscribe } from "../../adapters/transport/taskNotificationBus";
import { TaskNotificationEventType } from "../../adapters/transport/eventTypes";

interface TaskNotificationPayload {
  id: string;
  type: string;
  taskKind: string;
  projectId: string;
  taskId: string;
  title: string;
  message: string;
  severity: "info" | "success" | "warning" | "error";
  meta?: Record<string, unknown>;
}

const severityToType: Record<string, NotificationType> = {
  info: "info",
  success: "success",
  warning: "warning",
  error: "error",
};

export function useTaskNotificationListener(projectId: string | null) {
  useEffect(() => {
    if (!projectId) return;

    const handleEvent = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as TaskNotificationPayload;
        useNotificationStore.getState().push({
          id: `task-${data.id}`,
          type: severityToType[data.severity] ?? "info",
          message: `${data.title}: ${data.message}`,
          duration: data.severity === "error" ? 0 : 5000,
        });
      } catch {
        /* ignore parse errors */
      }
    };

    const unsubscribe = subscribe(projectId, {
      events: {
        [TaskNotificationEventType.TaskCompleted]: handleEvent,
        [TaskNotificationEventType.TaskFailed]: handleEvent,
      },
    });

    return unsubscribe;
  }, [projectId]);
}
