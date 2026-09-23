import { startFileUndoRetention } from "./services/agent-runtime/checkpoints/retention.js";
import { attachTerminalSockets } from "./services/terminals/terminal-socket.js";
import { terminalRoutes } from "./routes/terminals.js";
import { terminalManager } from "./services/terminals/terminal-manager.js";
import { runtimeAssetRoutes } from "./routes/runtime-assets.js";
import { sweepAssets } from "./services/agent-runtime/media-assets.js";
import type { Server } from "node:http";
import { closeDb } from "./db/index.js";
import { stopHostProcesses } from "./services/agent-runtime/process-ownership.js";
import { acquireRuntimeHost } from "./services/agent-runtime/runtime-host.js";
import { recoverRuntime } from "./services/agent-runtime/runtime-recovery.js";
import { runCoordinator } from "./services/agent-runtime/run-coordinator.js";
import path from "node:path";
import { installRuntimeAccess } from "./middleware/runtime-access.js";
import { startInteractionRecovery } from "./services/agent-runtime/agent-stream-proxy.js";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { API_SESSION_LOG_FILE, logger as pinoLogger } from "./lib/logger.js";
import { PORT, DATA_ROOT } from "./lib/env.js";
import { acpRoutes } from "./routes/acp.js";
import { healthRoutes } from "./routes/health.js";
import { projectRoutes } from "./routes/projects.js";
import { contextRoutes } from "./routes/context.js";
import { configRoutes } from "./routes/config.js";
import { mcpRoutes } from "./routes/mcp.js";
import { llmRoutes } from "./routes/llm.js";
import { agentRuntimeRoutes } from "./routes/agent-runtime.js";
import { extensionRoutes } from "./routes/extensions.js";
import { skillsRoutes, skillSourcesRoutes } from "./routes/skills.js";
import { wikiRoutes } from "./routes/wiki.js";
import { logRoutes } from "./routes/logs.js";
import { notificationRoutes } from "./routes/notifications.js";
import { projectSettingsRoutes } from "./routes/project-settings.js";
import { treeEmbeddingBenchRoutes } from "./routes/tree-embedding-bench.js";
import { fsRoutes } from "./routes/fs.js";
import { wslRoutes } from "./routes/wsl.js";
import { webSearchOAuthRoutes } from "./routes/web-search-oauth.js";
import { getDb } from "./db/index.js";
import { agentRuntimeStore } from "./services/agent-runtime/session-store.js";
import { wikiStore } from "./services/wiki/wiki-store.js";
import { ensureWikiProfileRegistered } from "./services/wiki/wiki-loop-profile.js";
import { ensurePlanProfileRegistered } from "./services/wiki/wiki-plan-profile.js";
import { ensureRefreshProfileRegistered } from "./services/wiki/wiki-refresh-profile.js";
import {
  ensureSynaxAgentRegistered,
  ensureLegacyGoalProfileRegistered,
} from "./services/agent-runtime/synax/index.js";
import { registerSessionTitleHooks } from "./services/agent-runtime/session-title-service.js";
import { wikiWriteQueue } from "./services/wiki/wiki-write-queue-service.js";
import { rebuildWikiFtsIndex } from "./services/wiki/wiki-fts.js";
import { startPermissionTimeoutSweeper } from "./services/agent-runtime/permission-timeout-sweeper.js";
import { closeAllBrowserSessions } from "./services/agent-runtime/tools/browser/browser-manager.js";

export const app = new Hono();

// --- 中间件 ---
installRuntimeAccess(app, {
  dataRoot: DATA_ROOT,
  webOrigins: [
    `http://localhost:${process.env.WEB_PORT ?? "5173"}`,
    `http://127.0.0.1:${process.env.WEB_PORT ?? "5173"}`,
  ],
  trustedHosts: process.env.SYNAX_TRUSTED_HOSTS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean),
});

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
app.route("/api/projects", extensionRoutes);
app.route("/api/acp", acpRoutes);
app.route("/api/context", contextRoutes);
app.route("/api/config", configRoutes);
app.route("/api/mcp", mcpRoutes);
app.route("/api/llm", llmRoutes);
app.route("/api/agent-runtime/assets", runtimeAssetRoutes);
app.route("/api/agent-runtime", agentRuntimeRoutes);
app.route("/api/skills", skillsRoutes);
app.route("/api/skill-sources", skillSourcesRoutes);
app.route("/api/wiki", wikiRoutes);
app.route("/api/notifications", notificationRoutes);
app.route("/api/logs", logRoutes);
app.route("/api/health", healthRoutes);
app.route("/api/prototypes/tree-embedding-bench", treeEmbeddingBenchRoutes);
app.route("/api/fs", fsRoutes);
app.route("/api/terminals", terminalRoutes);
app.route("/api/wsl", wslRoutes);
// OAuth providers redirect from a different site, so this state-validated callback
// intentionally lives outside the cookie-protected /api namespace.
app.route("/oauth/web-search", webSearchOAuthRoutes);

const runtimeHost = acquireRuntimeHost(DATA_ROOT);
void sweepAssets().catch((error) =>
  pinoLogger.warn({ error }, "Media cleanup failed"),
);
setInterval(() => {
  void sweepAssets().catch((error) =>
    pinoLogger.warn({ error }, "Media cleanup failed"),
  );
}, 3_600_000).unref();
process.env.SYNAX_RUNTIME_HOST_ID = runtimeHost.hostId;
process.env.SYNAX_RUNTIME_DATA_ROOT = path.resolve(DATA_ROOT);

// --- 初始化上下文数据库（提前触发 WAL 模式与迁移执行） ---
try {
  getDb();
} catch (err) {
  pinoLogger.error({ err }, "failed to initialize context db");
  throw err;
}

// --- 提前注册 wiki / plan profiles，确保服务重启后能恢复 session 并响应 skills 查询 ---
ensureWikiProfileRegistered();
ensurePlanProfileRegistered();
ensureRefreshProfileRegistered();
ensureSynaxAgentRegistered();
ensureLegacyGoalProfileRegistered();
registerSessionTitleHooks();

let httpServer: Server | undefined;
let closeTerminalSockets: (() => void) | undefined;
let shuttingDown = false;

let stopFileUndoRetention = () => {};
async function startRuntime(): Promise<void> {
  const recovery = await recoverRuntime(runtimeHost.hostId);
  if (recovery.reviewed)
    pinoLogger.warn(
      { count: recovery.reviewed },
      "interrupted executions reconciled or isolated to their original sessions",
    );
  // --- 启动时恢复 wiki 文档写入队列（先于 snapshot 恢复，避免误标记 writing 为 failed）---
  wikiWriteQueue
    .recoverOrphaned()
    .then(async ({ batches, items, interruptedSnapshotIds }) => {
      if (items > 0) {
        const suspended = await wikiWriteQueue.suspendAfterServerRestart(
          interruptedSnapshotIds,
        );
        pinoLogger.warn(
          { batches, items, suspended, snapshots: interruptedSnapshotIds },
          "suspended interrupted wiki write queue on startup — continue from Wiki UI",
        );
        return;
      }
      if (batches > 0 || items > 0) {
        pinoLogger.warn(
          { batches, items },
          "recovered orphaned wiki write queue on startup",
        );
      }
      wikiWriteQueue.resume();
    })
    .catch((err) => {
      pinoLogger.error({ err }, "failed to recover wiki write queue");
    });

  // --- 启动时恢复孤儿 wiki snapshot（服务器重启后卡在生成中状态）---
  wikiStore
    .recoverOrphanedSnapshots()
    .then((count) => {
      if (count > 0) {
        pinoLogger.warn(
          { count },
          "recovered orphaned wiki snapshots on startup",
        );
      }
    })
    .catch((err) => {
      pinoLogger.error({ err }, "failed to recover orphaned wiki snapshots");
    });

  // --- 启动时 backfill FTS 索引（对已有 block 建立搜索文本）---
  rebuildWikiFtsIndex().catch((err) => {
    pinoLogger.error({ err }, "failed to rebuild wiki FTS index on startup");
  });

  startPermissionTimeoutSweeper();
  stopFileUndoRetention = startFileUndoRetention();
  startInteractionRecovery();

  if (!shuttingDown) startServer(recovery.resumable);
}

function startServer(resumable: string[]): void {
  httpServer = serve(
    {
      fetch: app.fetch,
      port: PORT,
      hostname: "127.0.0.1",
    },
    (address) => {
      process.env.SYNAX_TERMINAL_HOST_ORIGIN = `http://127.0.0.1:${address.port}`;
      // Recovered tools must see the actual bound origin, never port zero.
      for (const sessionId of resumable) runCoordinator.resume(sessionId);
      pinoLogger.info(
        { logFile: API_SESSION_LOG_FILE },
        `Server listening on http://localhost:${address.port}`,
      );
      if (process.env.SYNAX_DESKTOP_SIDECAR === "1") {
        process.stdout.write(`SYNAX_DESKTOP_READY:${address.port}\n`);
      }
    },
  ) as Server;
  closeTerminalSockets = attachTerminalSockets(httpServer);
}

async function shutdownRuntime(): Promise<void> {
  stopFileUndoRetention();
  if (shuttingDown) return;
  shuttingDown = true;
  closeTerminalSockets?.();
  httpServer?.closeAllConnections();
  httpServer?.close();
  let failed = false;
  for (const id of runCoordinator.activeSessionIds()) {
    try {
      await runCoordinator.interrupt(id, "Runtime host is shutting down.");
    } catch (error) {
      failed = true;
      pinoLogger.error({ id, error }, "runtime shutdown unconfirmed");
    }
  }
  try {
    await terminalManager.shutdown();
  } catch (error) {
    failed = true;
    pinoLogger.error({ error }, "terminal shutdown unconfirmed");
  }
  const unresolved = await stopHostProcesses(runtimeHost.hostId);
  if (unresolved.length) {
    failed = true;
    pinoLogger.error(
      { count: unresolved.length },
      "owned processes require recovery",
    );
  }
  await closeAllBrowserSessions("Runtime host is shutting down.");
  runtimeHost.release();
  closeDb();
  process.exit(failed ? 1 : 0);
}
process.on("SIGINT", () => {
  void shutdownRuntime();
});
process.on("SIGTERM", () => {
  void shutdownRuntime();
});

// --- 启动服务 ---
void startRuntime().catch((error) => {
  pinoLogger.error({ error }, "runtime startup failed");
  runtimeHost.release();
  process.exitCode = 1;
});
