import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { API_SESSION_LOG_FILE, logger as pinoLogger } from "./lib/logger.js";
import { PORT } from "./lib/env.js";
import { coordinatesRoutes } from "./routes/coordinates.js";
import { healthRoutes } from "./routes/health.js";
import { projectRoutes } from "./routes/projects.js";
import { contextRoutes } from "./routes/context.js";
import { configRoutes } from "./routes/config.js";
import { llmRoutes } from "./routes/llm.js";
import { agentRuntimeRoutes } from "./routes/agent-runtime.js";
import { wikiRoutes } from "./routes/wiki.js";
import { logRoutes } from "./routes/logs.js";
import { getDb } from "./db/index.js";
import { agentRuntimeStore } from "./services/agent-runtime/session-store.js";
import { wikiStore } from "./services/wiki/wiki-store.js";

export const app = new Hono();

// --- 中间件 ---
app.use("*", cors());

// 请求日志
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  pinoLogger.info(
    { method: c.req.method, path: c.req.path, status: c.res.status, ms },
    "request",
  );
});

// --- 路由 ---
app.route("/api/projects", projectRoutes);
app.route("/api/coordinates", coordinatesRoutes);
app.route("/api/context", contextRoutes);
app.route("/api/config", configRoutes);
app.route("/api/llm", llmRoutes);
app.route("/api/agent-runtime", agentRuntimeRoutes);
app.route("/api/wiki", wikiRoutes);
app.route("/api/logs", logRoutes);
app.route("/api/health", healthRoutes);

// --- 初始化上下文数据库（提前触发 WAL 模式与迁移执行） ---
try {
  getDb();
} catch (err) {
  pinoLogger.error({ err }, "failed to initialize context db");
}

// --- 启动时恢复孤儿 running session ---
try {
  const recovered = agentRuntimeStore.recoverOrphanedSessions();
  if (recovered > 0) {
    pinoLogger.warn({ count: recovered }, "recovered orphaned running sessions on startup");
  }
} catch (err) {
  pinoLogger.error({ err }, "failed to recover orphaned sessions");
}

// --- 启动时恢复孤儿 wiki snapshot（服务器重启后卡在生成中状态）---
wikiStore.recoverOrphanedSnapshots().then((count) => {
  if (count > 0) {
    pinoLogger.warn({ count }, "recovered orphaned wiki snapshots on startup");
  }
}).catch((err) => {
  pinoLogger.error({ err }, "failed to recover orphaned wiki snapshots");
});

function startServer(): void {
  serve({
    fetch: app.fetch,
    port: PORT,
    hostname: "127.0.0.1",
  });

  pinoLogger.info(
    { logFile: API_SESSION_LOG_FILE },
    `Server listening on http://localhost:${PORT}`,
  );
}

// --- 启动服务 ---
startServer();
