import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { localAgentNode } from "../composition/agent-node.js";
import { DATA_ROOT, PORT } from "../infrastructure/runtime/env.js";
import { logger } from "../infrastructure/runtime/logger.js";
import { installRuntimeAccess } from "../transport/http/middleware/runtime-access.js";
import { healthRoutes } from "../transport/http/health.js";
import { projectRoutes } from "../transport/http/projects.js";
import { contextRoutes } from "../transport/http/context.js";
import { configRoutes } from "../transport/http/config.js";
import { agentRuntimeRoutes } from "../transport/http/agent-runtime.js";
import { extensionRoutes } from "../transport/http/extensions.js";
import { skillsRoutes, skillSourcesRoutes } from "../transport/http/skills.js";
import { logRoutes } from "../transport/http/logs.js";
import { notificationRoutes } from "../transport/http/notifications.js";
import { projectSettingsRoutes } from "../transport/http/project-settings.js";
import { fsRoutes } from "../transport/http/fs.js";
import { wslRoutes } from "../transport/http/wsl.js";

const app = new Hono();
app.get("/api/agent-node", (c) => c.json({
  nodeId: localAgentNode.identity.nodeId,
  kind: localAgentNode.identity.kind,
  protocolVersion: localAgentNode.identity.protocolVersion,
}));

installRuntimeAccess(app, {
  dataRoot: DATA_ROOT,
  webOrigins: [
    `http://localhost:${process.env.WEB_PORT ?? "5173"}`,
    `http://127.0.0.1:${process.env.WEB_PORT ?? "5173"}`,
    `https://localhost:${process.env.WEB_PORT ?? "5173"}`,
    `https://127.0.0.1:${process.env.WEB_PORT ?? "5173"}`,
  ],
  trustedHosts: process.env.SYNAX_TRUSTED_HOSTS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean),
});

app.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD")
    return c.json({ error: "Read service accepts GET requests only." }, 405);
  if (c.req.path.includes("/stream") || c.req.path.endsWith("/live") || c.req.path === "/api/context/sync")
    return c.json({ error: "Streaming endpoints belong to the primary runtime." }, 405);
  await next();
});

app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  logger.debug(
    { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - start },
    "read-service request",
  );
});

app.route("/api/projects", projectRoutes);
app.route("/api/projects", projectSettingsRoutes);
app.route("/api/projects", extensionRoutes);
app.route("/api/context", contextRoutes);
app.route("/api/config", configRoutes);
app.route("/api/agent-runtime", agentRuntimeRoutes);
app.route("/api/skills", skillsRoutes);
app.route("/api/skill-sources", skillSourcesRoutes);
app.route("/api/notifications", notificationRoutes);
app.route("/api/logs", logRoutes);
app.route("/api/health", healthRoutes);
app.route("/api/fs", fsRoutes);
app.route("/api/wsl", wslRoutes);

const server = serve(
  { fetch: app.fetch, port: PORT, hostname: "127.0.0.1" },
  (address) => {
    if (typeof process.send === "function") process.send({ type: "ready", port: address.port });
    logger.info({ port: address.port }, "Read service listening");
  },
);

function shutdown(): void {
  server.close();
  process.exitCode = 0;
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
