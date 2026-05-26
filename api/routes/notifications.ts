import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  taskNotificationBus,
  type TaskNotificationEvent,
} from "../services/notifications/task-notification-bus.js";

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

    await stream.writeSSE({ event: "connected", data: JSON.stringify({ projectId }) });

    const heartbeat = setInterval(() => {
      if (closed) return;
      stream
        .writeSSE({ event: "ping", data: String(Date.now()) })
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
