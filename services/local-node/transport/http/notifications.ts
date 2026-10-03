import { observationLifetime } from "../../infrastructure/runtime/observation-lifetime.js";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  NotificationStreamEventType,
  taskNotificationBus,
  type TaskNotificationEvent,
} from "../../modules/notifications/task-notification-bus.js";

export const notificationRoutes = new Hono();

notificationRoutes.get("/stream", (c) => {
  const projectId = c.req.query("projectId");
  if (!projectId) {
    return c.json({ error: "projectId required" }, 400);
  }

  return streamSSE(c, async (stream) => {
    const lifetime = observationLifetime(c.req.raw.signal, stream);

    const onEvent = (event: TaskNotificationEvent) => {
      if (lifetime.signal.aborted) return;
      stream
        .writeSSE({ event: event.type, data: JSON.stringify(event), id: event.id })
        .catch(lifetime.stop);
    };

    const unsubscribe = taskNotificationBus.subscribe(projectId, onEvent);

    const heartbeat = setInterval(() => {
      if (!lifetime.signal.aborted)
        void stream.writeSSE({ event: NotificationStreamEventType.Ping, data: String(Date.now()) }).catch(lifetime.stop);
    }, 25_000);
    try {
      if (lifetime.signal.aborted) return;
      await stream.writeSSE({ event: NotificationStreamEventType.Connected, data: JSON.stringify({ projectId }) });
      await lifetime.ended;
    } finally { clearInterval(heartbeat); unsubscribe(); lifetime.dispose(); }
  });
});
