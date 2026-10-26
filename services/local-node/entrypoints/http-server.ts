import { ObservationTransport, OBSERVATION_SOCKET_PATH } from "../modules/realtime/observation-transport.js";
import { ensureGitMrProfileRegistered } from '../modules/agent-runtime/git/profile.js';
import { attachTerminalSockets } from "../infrastructure/terminals/terminal-socket.js";
import { terminalRoutes } from "../transport/http/terminals.js";
import { terminalManager } from "../infrastructure/terminals/terminal-manager.js";
import { runtimeAssetRoutes } from "../transport/http/runtime-assets.js";
import { sweepAssets } from "../modules/agent-runtime/media-assets.js";
import type { Server } from "node:http";
import { stopHostProcesses } from "../modules/agent-runtime/process-ownership.js";
import { randomUUID } from "node:crypto";
import { businessStore } from "../infrastructure/persistence/business-store.js";
import {
  recoverRuntimeSession,
  needsRuntimeRecovery,
} from "../modules/agent-runtime/runtime-recovery.js";
import { SessionRecovery, installSessionRecovery, stopSessionRecovery } from '../modules/agent-runtime/session-recovery.js';
import { runCoordinator } from "../modules/agent-runtime/run-coordinator.js";
import path from "node:path";
import { installRuntimeAccess } from "../transport/http/middleware/runtime-access.js";
import { startInteractionRecovery } from "../modules/agent-runtime/agent-stream-proxy.js";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { localAgentNode } from "../composition/agent-node.js";
import { API_SESSION_LOG_FILE, logger as pinoLogger } from "../infrastructure/runtime/logger.js";
import { PORT, DATA_ROOT } from "../infrastructure/runtime/env.js";
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
import { agentRuntimeStore } from "../modules/agent-runtime/session-store.js";
import { recoverMediaJobs } from "../modules/media/jobs.js";
import {
  ensureSynaxAgentRegistered,
  ensureLegacyGoalProfileRegistered,
} from "../modules/agent-runtime/synax/index.js";
import {
  ensureSessionTitleGenerated,
  needsGeneratedSessionTitle,
  registerSessionTitleHooks,
} from "../modules/agent-runtime/session-title-service.js";
import { startPermissionTimeoutSweeper, stopPermissionTimeoutSweeper } from "../modules/agent-runtime/permission-timeout-sweeper.js";
import { startSessionArchiveRetention } from "../modules/agent-runtime/session-archive-retention.js";
import { closeAllBrowserSessions } from "../modules/agent-runtime/tools/browser/browser-manager.js";
import { setRuntimeCuaConnection } from "../infrastructure/mcp/runtime-cua-config.js";
import { mcpClientManager } from "../infrastructure/mcp/mcp-client-manager.js";
import { startRustRuntimeSidecar, stopRustRuntimeSidecar, type RustRuntimeSidecarHandle } from "../infrastructure/runtime/rust-sidecar.js";
import { workspaceIndexService } from "../modules/workspace-index-service.js";

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

// Refresh cross-process metadata before requests and commit before returning.
app.use('/api/*', async (c, next) => {
  // Health/logs remain responsive while history is loading. Other routes only
  // refresh the small policy/configuration cache, never all sessions/assets.
  if (c.req.path === '/api/health' || c.req.path.startsWith('/api/logs')) return next();
  await businessStore.refresh();
  await next();
  await businessStore.flush();
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

// RocksDB holds the exclusive data-root lock for the lifetime of the Rust sidecar.
const runtimeHost = { hostId: randomUUID() };
process.env.SYNAX_RUNTIME_HOST_ID = runtimeHost.hostId;
process.env.SYNAX_RUNTIME_DATA_ROOT = path.resolve(DATA_ROOT);
process.env.SYNAX_RUNTIME_SIDECAR_SUPERVISOR ??= '1';
process.env.SYNAX_RUNTIME_SIDECAR_STREAM ??= 'authoritative';
if (process.env.NODE_ENV !== 'test') process.env.SYNAX_AGENT_LOOP_ENGINE ??= 'rust';

ensureGitMrProfileRegistered();
ensureSynaxAgentRegistered();
ensureLegacyGoalProfileRegistered();
registerSessionTitleHooks();

let httpServer: Server | undefined;
let closeTerminalSockets: (() => void) | undefined;
let closeObservationSockets: (() => void) | undefined;
let shuttingDown = false;
let rustRuntimeSidecar: RustRuntimeSidecarHandle | null = null;

let stopSessionArchiveRetention = () => {};
let stopInteractionRecovery: () => Promise<void> = async () => {};
const startupLifetime = new AbortController();
let sessionRecovery: SessionRecovery;
async function startupPhase<T>(phase: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  pinoLogger.info({ event: 'runtime.startup_phase', phase, state: 'starting' }, 'Runtime startup phase');
  const result = await work();
  pinoLogger.info({ event: 'runtime.startup_phase', phase, state: 'completed', durationMs: Math.round(performance.now() - started) }, 'Runtime startup phase');
  return result;
}
function configureSessionRecovery(includeCurrentHost = false): SessionRecovery {
  const recovery = new SessionRecovery(async sessionId => {
    await recoverRuntimeSession(runtimeHost.hostId, sessionId, includeCurrentHost);
  });
  sessionRecovery = recovery;
  installSessionRecovery(recovery);
  return recovery;
}

async function loadSessionsInBackground(recovery: SessionRecovery): Promise<void> {
  await startupPhase('session_index', () => agentRuntimeStore.hydrateSessions(startupLifetime.signal));
  if (shuttingDown || sessionRecovery !== recovery) return;
  await recovery.warm(agentRuntimeStore.listSessions({ limit: Infinity, includePreparing: true }).filter(needsRuntimeRecovery).map(session => session.id), (sessionId, error) => {
    pinoLogger.error({ event: 'runtime.session_recovery_failed', sessionId, error }, 'Session recovery failed; other sessions remain available');
  });
  if (shuttingDown || sessionRecovery !== recovery) return;
  for (const session of agentRuntimeStore.listSessions({ limit: Infinity })) {
    if (needsGeneratedSessionTitle(session)) ensureSessionTitleGenerated(session.id);
  }
  stopSessionArchiveRetention = startSessionArchiveRetention();
}

function backgroundSessions(recovery: SessionRecovery): void {
  void loadSessionsInBackground(recovery).catch(error => {
    if (!shuttingDown) pinoLogger.error({ error }, 'Background session loading failed');
  });
}
async function startRuntime(): Promise<void> {
  process.env.SYNAX_RUNTIME_SIDECAR_SUPERVISOR ??= '1';
  process.env.SYNAX_RUNTIME_SIDECAR_STREAM ??= 'authoritative';
  if (process.env.NODE_ENV !== 'test') process.env.SYNAX_AGENT_LOOP_ENGINE ??= 'rust';
  const recovery = configureSessionRecovery();
  rustRuntimeSidecar = await startupPhase('rust_runtime', () => startRustRuntimeSidecar(async () => {
    await stopSessionRecovery();
    if (!shuttingDown) backgroundSessions(configureSessionRecovery(true));
  }));
  if (shuttingDown) { await stopRustRuntimeSidecar(rustRuntimeSidecar); return; }
  await startupPhase('business_store', () => businessStore.refresh());
  if (shuttingDown) return;
  // Small metadata is ready for synchronous policy checks. Historical session
  // replay and recovery do not participate in the API readiness barrier.
  const mediaJobs = recoverMediaJobs();
  if (mediaJobs > 0) pinoLogger.info({ count: mediaJobs }, "recovered media generation jobs");
  await startServer();
  backgroundSessions(recovery);
  // Index existing workspace roots after the runtime is ready. The scan is
  // intentionally fire-and-forget so app startup and the first HTTP response
  // never wait for a large repository.
  void workspaceIndexService.start();
  void sweepAssets().catch(error => pinoLogger.warn({error}, "Media cleanup failed"));
  startPermissionTimeoutSweeper();
  stopInteractionRecovery = startInteractionRecovery();
}

function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
  httpServer = serve(
    {
      fetch: app.fetch,
      port: PORT,
      hostname: "127.0.0.1",
    },
    (address) => {
      process.env.SYNAX_TERMINAL_HOST_ORIGIN = `http://127.0.0.1:${address.port}`;
      pinoLogger.info(
        { logFile: API_SESSION_LOG_FILE },
        `Server listening on http://localhost:${address.port}`,
      );
      if (process.env.SYNAX_DESKTOP_SIDECAR === "1") {
        process.stdout.write(`SYNAX_DESKTOP_READY:${address.port}\n`);
      }
      resolve();
    },
  ) as Server;
  httpServer.once('error', reject);
  closeTerminalSockets = attachTerminalSockets(httpServer);
  closeObservationSockets = observations.attach(httpServer);
  httpServer.on("upgrade", (request, socket) => {
    try {
      const pathname = new URL(request.url ?? "", "http://localhost").pathname;
      if (pathname !== OBSERVATION_SOCKET_PATH && pathname !== "/api/terminals/socket") socket.destroy();
    } catch { socket.destroy(); }
  });
  });
}

async function shutdownRuntime(): Promise<void> {
  stopSessionArchiveRetention();
  if (shuttingDown) return;
  shuttingDown = true;
  const maintenanceStopped = Promise.all([stopPermissionTimeoutSweeper(), stopInteractionRecovery()]);
  startupLifetime.abort();
  closeObservationSockets?.();
  closeTerminalSockets?.();
  httpServer?.closeAllConnections();
  httpServer?.close();
  await stopSessionRecovery();
  await maintenanceStopped;
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
  mcpClientManager.closeAll();
  // Deferred title and session patches may be queued outside an HTTP request.
  // Drain them before stopping the sidecar, otherwise the next launch restores
  // the pre-update placeholder values.
  await agentRuntimeStore.flush();
  await businessStore.flush();
  await stopRustRuntimeSidecar(rustRuntimeSidecar);
  rustRuntimeSidecar = null;
  process.exit(failed ? 1 : 0);
}
process.on("SIGINT", () => {
  void shutdownRuntime();
});
process.on("SIGTERM", () => {
  void shutdownRuntime();
});


setInterval(() => {
  void sweepAssets().catch((error) =>
    pinoLogger.warn({ error }, "Media cleanup failed"),
  );
}, 3_600_000).unref();

// --- 启动服务 ---
void startRuntime().catch((error) => {
  pinoLogger.error({ error }, "runtime startup failed");
  process.exitCode = 1;
});
