import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { API_SESSION_LOG_FILE, logger as pinoLogger } from "./lib/logger.js";
import { PORT } from "./lib/env.js";
import { acpRoutes } from "./routes/acp.js";
import { healthRoutes } from "./routes/health.js";
import { projectRoutes } from "./routes/projects.js";
import { contextRoutes } from "./routes/context.js";
import { configRoutes } from "./routes/config.js";
import { llmRoutes } from "./routes/llm.js";
import { agentRuntimeRoutes } from "./routes/agent-runtime.js";
import { wikiRoutes } from "./routes/wiki.js";
import { logRoutes } from "./routes/logs.js";
import { notificationRoutes } from "./routes/notifications.js";
import { projectSettingsRoutes } from "./routes/project-settings.js";
import { treeEmbeddingBenchRoutes } from "./routes/tree-embedding-bench.js";
import { getDb } from "./db/index.js";
import { agentRuntimeStore } from "./services/agent-runtime/session-store.js";
import { wikiStore } from "./services/wiki/wiki-store.js";
import { ensureWikiProfileRegistered } from "./services/wiki/wiki-loop-profile.js";
import { ensurePlanProfileRegistered } from "./services/wiki/wiki-plan-profile.js";
import { ensureRefreshProfileRegistered } from "./services/wiki/wiki-refresh-profile.js";
import { ensureSynaxAgentRegistered, ensureLegacyGoalProfileRegistered } from "./services/agent-runtime/synax/index.js";
import { registerSessionTitleHooks } from "./services/agent-runtime/session-title-service.js";
import { wikiWriteQueue } from "./services/wiki/wiki-write-queue-service.js";
import { rebuildWikiFtsIndex } from "./services/wiki/wiki-fts.js";
import { startPermissionTimeoutSweeper } from "./services/agent-runtime/permission-timeout-sweeper.js";

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
app.route("/api/projects", projectSettingsRoutes);
app.route("/api/acp", acpRoutes);
app.route("/api/context", contextRoutes);
app.route("/api/config", configRoutes);
app.route("/api/llm", llmRoutes);
app.route("/api/agent-runtime", agentRuntimeRoutes);
app.route("/api/wiki", wikiRoutes);
app.route("/api/notifications", notificationRoutes);
app.route("/api/logs", logRoutes);
app.route("/api/health", healthRoutes);
app.route("/api/prototypes/tree-embedding-bench", treeEmbeddingBenchRoutes);

// --- 初始化上下文数据库（提前触发 WAL 模式与迁移执行） ---
try {
  getDb();
} catch (err) {
  pinoLogger.error({ err }, "failed to initialize context db");
}

// --- 提前注册 wiki / plan profiles，确保服务重启后能恢复 session 并响应 skills 查询 ---
ensureWikiProfileRegistered();
ensurePlanProfileRegistered();
ensureRefreshProfileRegistered();
ensureSynaxAgentRegistered();
ensureLegacyGoalProfileRegistered();
registerSessionTitleHooks();

// --- 启动时恢复孤儿 running session ---
try {
  const recovered = agentRuntimeStore.recoverOrphanedSessions();
  if (recovered > 0) {
    pinoLogger.warn({ count: recovered }, "recovered orphaned running sessions on startup");
  }
} catch (err) {
  pinoLogger.error({ err }, "failed to recover orphaned sessions");
}

// --- 启动时恢复 wiki 文档写入队列（先于 snapshot 恢复，避免误标记 writing 为 failed）---
wikiWriteQueue.recoverOrphaned().then(async ({ batches, items, interruptedSnapshotIds }) => {
  if (items > 0) {
    const suspended = await wikiWriteQueue.suspendAfterServerRestart(interruptedSnapshotIds);
    pinoLogger.warn(
      { batches, items, suspended, snapshots: interruptedSnapshotIds },
      "suspended interrupted wiki write queue on startup — continue from Wiki UI",
    );
    return;
  }
  if (batches > 0 || items > 0) {
    pinoLogger.warn({ batches, items }, "recovered orphaned wiki write queue on startup");
  }
  wikiWriteQueue.resume();
}).catch((err) => {
  pinoLogger.error({ err }, "failed to recover wiki write queue");
});

// --- 启动时恢复孤儿 wiki snapshot（服务器重启后卡在生成中状态）---
wikiStore.recoverOrphanedSnapshots().then((count) => {
  if (count > 0) {
    pinoLogger.warn({ count }, "recovered orphaned wiki snapshots on startup");
  }
}).catch((err) => {
  pinoLogger.error({ err }, "failed to recover orphaned wiki snapshots");
});

// --- 启动时 backfill FTS 索引（对已有 block 建立搜索文本）---
rebuildWikiFtsIndex().catch((err) => {
  pinoLogger.error({ err }, "failed to rebuild wiki FTS index on startup");
});

startPermissionTimeoutSweeper();

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
