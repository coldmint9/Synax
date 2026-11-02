import { randomUUID } from "node:crypto";
import { logger } from "../../../infrastructure/runtime/logger.js";
import { assertLlmProviderConfigured } from "../../../infrastructure/llm-runtime/provider-check.js";
import type { AgentSession } from "../contracts.js";
import { profileService } from "../profile-service.js";
import { runCoordinator } from "../run-coordinator.js";
import { runtimeBus, type RuntimeBusEvent } from "../runtime-bus.js";
import { emitRuntimeBusEvent } from "../runtime-bus-bridge.js";
import { agentRuntimeStore } from "../session-store.js";
import { ConnectivityMonitor } from "./connectivity.js";
import type { AutoResumeSnapshot } from "./contracts.js";
import { AutoResumeJournal } from "./journal.js";
import { SessionAutoResumeService, type AutoResumeChange } from "./service.js";

export type {
  AutoResumeCause,
  AutoResumeItem,
  AutoResumePhase,
  AutoResumeRecord,
  AutoResumeSnapshot,
} from "./contracts.js";
export { isNetworkFailure, planSessionResume } from "./contracts.js";

let service: SessionAutoResumeService | undefined;
let monitor: ConnectivityMonitor | undefined;
let unsubscribe: (() => void) | undefined;
let stopConnectivityWatch: (() => void) | undefined;

/** Operators (and tests) can turn the behaviour off entirely. */
export function autoResumeEnabled(): boolean {
  return process.env.SYNAX_AUTO_RESUME !== "0";
}

function startDelayMs(): number | undefined {
  const configured = Number(process.env.SYNAX_AUTO_RESUME_DELAY_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : undefined;
}

/**
 * Continue one session exactly the way the composer's play button does: a
 * `continue` turn without input heals the resting session from its Work
 * checkpoint instead of replaying the user's original prompt.
 */
async function resumeSession(sessionId: string): Promise<void> {
  const session = agentRuntimeStore.getSession(sessionId);
  assertLlmProviderConfigured(session.projectId);
  await runCoordinator.submitAsync(
    sessionId,
    {},
    `auto-resume:${sessionId}:${randomUUID()}`,
    "continue",
  );
}

function publish(change: AutoResumeChange): void {
  emitRuntimeBusEvent({
    type: "session_auto_resume",
    sessionId: change.sessionId,
    patch: {
      phase: change.removed ? null : change.phase,
      attempts: change.attempts ?? 0,
      nextAttemptAt: change.nextAttemptAt ?? null,
      online: change.online,
      removed: change.removed,
    },
  });
}

function isEmbedded(session: AgentSession): boolean {
  try {
    return profileService.getForSession(session).executionHost === "embedded";
  } catch {
    return false;
  }
}

function handleRuntimeEvent(instance: SessionAutoResumeService, event: RuntimeBusEvent): void {
  if (event.type !== "session_changed") return;
  const patch = event.patch;
  if (!patch) return;
  instance.handleSessionPatch(event.sessionId, {
    status: patch.status,
    blockedReason: patch.blockedReason,
    stopReason: patch.stopReason,
    sessionMetadata: patch.sessionMetadata,
  });
}

/**
 * Mount the auto-resume supervisor on this runtime host.
 *
 * Called once the HTTP server is serving: the startup delay inside the service
 * keeps the first seconds of a launch free for the session index and recovery,
 * and every later transition is owned by the runtime bus.
 */
export function startSessionAutoResume(): SessionAutoResumeService | undefined {
  if (!autoResumeEnabled() || service) return service;
  monitor = new ConnectivityMonitor();
  const current = new SessionAutoResumeService({
    journal: new AutoResumeJournal(),
    sessions: {
      list: () => agentRuntimeStore.listSessions({ limit: Infinity, includePreparing: true }),
      get: (sessionId) => agentRuntimeStore.tryGetSession(sessionId),
    },
    resume: resumeSession,
    isOnline: () => monitor?.isOnline ?? true,
    isEmbedded,
    noteNetworkFailure: () => monitor?.noteNetworkFailure(),
    onChange: publish,
    beforeScan: async () => {
      // Share the index replay the runtime already runs in the background.
      await agentRuntimeStore.hydrateSessions().catch((error) =>
        logger.warn({ error }, "[auto-resume] session index could not be read"),
      );
    },
    // Worker-owned rows are mirrored here; settle them before acting on status.
    refreshSession: (sessionId) => agentRuntimeStore.hydrateSessionSummary(sessionId, true),
    startDelayMs: startDelayMs(),
  });
  service = current;
  stopConnectivityWatch = monitor.subscribe((online) => {
    logger.info({ online }, "[auto-resume] connectivity recovered");
    if (online) current.releaseNetworkWait();
    for (const record of current.snapshot().items)
      publish({
        sessionId: record.sessionId,
        removed: false,
        phase: online ? "queued" : "waiting_network",
        attempts: record.attempts,
        nextAttemptAt: record.nextAttemptAt,
        online,
      });
    if (online) void current.tick();
  });
  monitor.start();
  unsubscribe = runtimeBus.subscribe((event) => handleRuntimeEvent(current, event));
  current.start();
  logger.info("[auto-resume] supervisor started");
  return current;
}

/**
 * Record what is executing right now, then stop. Called from the shutdown
 * pipeline before sessions are interrupted, so the next launch knows which
 * sessions were mid-turn.
 */
export async function stopSessionAutoResume(): Promise<void> {
  const current = service;
  if (!current) return;
  try {
    current.captureActiveSessions();
  } catch (error) {
    logger.warn({ error }, "[auto-resume] sessions could not be captured for restart");
  }
  unsubscribe?.();
  unsubscribe = undefined;
  stopConnectivityWatch?.();
  stopConnectivityWatch = undefined;
  monitor?.stop();
  monitor = undefined;
  service = undefined;
  await current.stop();
  logger.info("[auto-resume] supervisor stopped");
}

export function sessionAutoResumeSnapshot(): AutoResumeSnapshot {
  return (
    service?.snapshot() ?? { online: true, items: [] }
  );
}

export function dismissSessionAutoResume(sessionId: string): boolean {
  return service?.dismiss(sessionId) ?? false;
}

/** Test seam: the exact shape the HTTP route uses. */
export type { SessionAutoResumeService };
