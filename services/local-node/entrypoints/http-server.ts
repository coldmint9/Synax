import { ObservationTransport, OBSERVATION_SOCKET_PATH } from "../modules/realtime/observation-transport.js";
import { ensureGitMrProfileRegistered } from '../modules/agent-runtime/git/profile.js';
import { startFileUndoRetention } from "../modules/agent-runtime/checkpoints/retention.js";
import { attachTerminalSockets } from "../infrastructure/terminals/terminal-socket.js";
import { terminalRoutes } from "../transport/http/terminals.js";
import { terminalManager } from "../infrastructure/terminals/terminal-manager.js";
import { runtimeAssetRoutes } from "../transport/http/runtime-assets.js";
import { sweepAssets } from "../modules/agent-runtime/media-assets.js";
import type { Server } from "node:http";
import { closeDb } from "../infrastructure/database/index.js";
import { stopHostProcesses } from "../modules/agent-runtime/process-ownership.js";
import { acquireRuntimeHost } from "../modules/agent-runtime/runtime-host.js";
import {
  isDurableRuntimeCheckpoint,
  recoverRuntime,
} from "../modules/agent-runtime/runtime-recovery.js";
import { runCoordinator } from "../modules/agent-runtime/run-coordinator.js";
import path from "node:path";
import { installRuntimeAccess } from "../transport/http/middleware/runtime-access.js";
import { startInteractionRecovery } from "../modules/agent-runtime/agent-stream-proxy.js";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { localAgentNode } from "../composition/agent-node.js";
import { API_SESSION_LOG_FILE, logger as pinoLogger } from "../infrastructure/runtime/logger.js";
import { PORT, DATA_ROOT } from "../infrastructure/runtime/env.js";
import { acpRoutes } from "../transport/http/acp.js";
import { healthRoutes } from "../transport/http/health.js";
import { projectRoutes } from "../transport/http/projects.js";
import { contextRoutes } from "../transport/http/context.js";
import { configRoutes } from "../transport/http/config.js";
import { mcpRoutes } from "../transport/http/mcp.js";
import { llmRoutes } from "../transport/http/llm.js";
import { agentRuntimeRoutes } from "../transport/http/agent-runtime.js";
import { extensionRoutes } from "../transport/http/extensions.js";
import { skillsRoutes, skillSourcesRoutes } from "../transport/http/skills.js";
import { logRoutes } from "../transport/http/logs.js";
import { notificationRoutes } from "../transport/http/notifications.js";
import { projectSettingsRoutes } from "../transport/http/project-settings.js";
import { fsRoutes } from "../transport/http/fs.js";
import { wslRoutes } from "../transport/http/wsl.js";
import { webSearchOAuthRoutes } from "../transport/http/web-search-oauth.js";
import { getDb } from "../infrastructure/database/index.js";
import { agentRuntimeStore } from "../modules/agent-runtime/session-store.js";
import { recoverMediaJobs } from "../modules/media/jobs.js";
import {
  ensureSynaxAgentRegistered,
  ensureLegacyGoalProfileRegistered,
} from "../modules/agent-runtime/synax/index.js";
import { registerSessionTitleHooks } from "../modules/agent-runtime/session-title-service.js";
import { startPermissionTimeoutSweeper } from "../modules/agent-runtime/permission-timeout-sweeper.js";
import { startSessionArchiveRetention } from "../modules/agent-runtime/session-archive-retention.js";
import { closeAllBrowserSessions } from "../modules/agent-runtime/tools/browser/browser-manager.js";
import { setRuntimeCuaConnection } from "../infrastructure/mcp/runtime-cua-config.js";
import { mcpClientManager } from "../infrastructure/mcp/mcp-client-manager.js";

export const app = new Hono();
app.get("/api/agent-node", (c) => c.json({
  nodeId: localAgentNode.identity.nodeId,
  kind: localAgentNode.identity.kind,
  protocolVersion: localAgentNode.identity.protocolVersion,
}));
const observations = new ObservationTransport(request => app.fetch(request));

// --- 中间件 ---
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
app.route("/api/realtime", observations.routes);
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
app.route("/api/notifications", notificationRoutes);
app.route("/api/logs", logRoutes);
app.route("/api/health", healthRoutes);
app.route("/api/fs", fsRoutes);
app.route("/api/terminals", terminalRoutes);
app.route("/api/wsl", wslRoutes);
// OAuth providers redirect from a different site, so this state-validated callback
// intentionally lives outside the cookie-protected /api namespace.
app.route("/oauth/web-search", webSearchOAuthRoutes);

// Only the Electron parent may inject a Cua connection. Never expose a public
// HTTP endpoint or persist its private socket/launch environment.
function acceptParentMessage(message: unknown): void {
  if (!message || typeof message !== 'object' || (message as { type?: unknown }).type !== 'synax:cua-connection') return;
  try {
    const changed = setRuntimeCuaConnection((message as { connection?: unknown }).connection ?? null);
    if (changed) mcpClientManager.closeCua();
  } catch (error) {
    pinoLogger.warn({ error: error instanceof Error ? error.message : String(error) }, '[cua] rejected parent connection');
  }
}
process.on('message', acceptParentMessage);
const electronParentPort = (process as typeof process & { parentPort?: { on(event: string, listener: (event: { data: unknown }) => void): void } }).parentPort;
electronParentPort?.on('message', event => acceptParentMessage(event.data));

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

ensureGitMrProfileRegistered();
ensureSynaxAgentRegistered();
ensureLegacyGoalProfileRegistered();
registerSessionTitleHooks();

let httpServer: Server | undefined;
let closeTerminalSockets: (() => void) | undefined;
let closeObservationSockets: (() => void) | undefined;
let shuttingDown = false;

let stopFileUndoRetention = () => {};
let stopSessionArchiveRetention = () => {};
async function startRuntime(): Promise<void> {
  const recovery = await recoverRuntime(runtimeHost.hostId);
  const mediaJobs = recoverMediaJobs();
  if (mediaJobs > 0) pinoLogger.info({ count: mediaJobs }, "recovered media generation jobs");
  if (recovery.reviewed)
    pinoLogger.warn(
      { count: recovery.reviewed },
      "interrupted executions reconciled or isolated to their original sessions",
    );
  startPermissionTimeoutSweeper();
  stopFileUndoRetention = startFileUndoRetention();
  stopSessionArchiveRetention = startSessionArchiveRetention();
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
  closeObservationSockets = observations.attach(httpServer);
  httpServer.on("upgrade", (request, socket) => {
    try {
      const pathname = new URL(request.url ?? "", "http://localhost").pathname;
      if (pathname !== OBSERVATION_SOCKET_PATH && pathname !== "/api/terminals/socket") socket.destroy();
    } catch { socket.destroy(); }
  });
}

async function shutdownRuntime(): Promise<void> {
  stopFileUndoRetention();
  stopSessionArchiveRetention();
  if (shuttingDown) return;
  shuttingDown = true;
  closeObservationSockets?.();
  closeTerminalSockets?.();
  httpServer?.closeAllConnections();
  httpServer?.close();
  let failed = false;
  for (const id of runCoordinator.activeSessionIds()) {
    const session = agentRuntimeStore.tryGetSession(id);
    if (session && isDurableRuntimeCheckpoint(session.status)) continue;
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
  mcpClientManager.closeAll();
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
