import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  NotificationStreamEventType,
  taskNotificationBus,
  type TaskNotificationEvent,
} from "../services/notifications/task-notification-bus.js";
import { buildWikiSnapshotEvent, WikiSnapshotEventReason } from "../services/wiki/wiki-snapshot-events.js";

export const notificationRoutes = new Hono();

notificationRoutes.get("/stream", (c) => {
  const projectId = c.req.query("projectId");
  if (!projectId) {
    return c.json({ error: "projectId required" }, 400);
  }

  return streamSSE(c, async (stream) => {
    let closed = false;

    const onEvent = (event: TaskNotificationEvent) => {
      if (closed) return;
      stream
        .writeSSE({ event: event.type, data: JSON.stringify(event), id: event.id })
        .catch(() => { closed = true; });
    };

    const unsubscribe = taskNotificationBus.subscribe(projectId, onEvent);

    await stream.writeSSE({ event: NotificationStreamEventType.Connected, data: JSON.stringify({ projectId }) });
    try {
      const snapshotEvent = await buildWikiSnapshotEvent(projectId, WikiSnapshotEventReason.Connected);
      await stream.writeSSE({
        event: snapshotEvent.type,
        data: JSON.stringify(snapshotEvent),
        id: snapshotEvent.id,
      });
    } catch {
      // Keep the notification stream alive even if the snapshot read fails.
    }

    const heartbeat = setInterval(() => {
      if (closed) return;
      stream
        .writeSSE({ event: NotificationStreamEventType.Ping, data: String(Date.now()) })
        .catch(() => { closed = true; });
    }, 25_000);

    c.req.raw.signal.addEventListener("abort", () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });

    await new Promise<void>((resolve) => {
      c.req.raw.signal.addEventListener("abort", () => resolve(), { once: true });
    });

    clearInterval(heartbeat);
    unsubscribe();
  });
});
