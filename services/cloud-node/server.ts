import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cloudAgentNode } from "./composition/agent-node.js";

export const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, node: cloudAgentNode.identity }));

app.post("/tasks", async (c) => {
  const body = (await c.req.json()) as { prompt?: unknown };
  if (typeof body.prompt !== "string" || body.prompt.trim() === "") {
    return c.json({ error: "prompt is required" }, 400);
  }

  return c.json(cloudAgentNode.createTask(body.prompt));
});

if (process.env.SYNAX_CLOUD_NODE_START === "1") {
  serve({ fetch: app.fetch, port: Number(process.env.CLOUD_PORT ?? "3220") });
}
