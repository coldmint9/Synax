import type { AgentProfileKind, ThinkingMode } from "./contracts.js";
import { agentLoopRuntime, type AgentLoopRuntime } from "./loop-runtime.js";
import {
  agentSessionRuntime,
  type AgentSessionRuntime,
} from "./session-runtime.js";
import { agentRuntimeStore, type AgentRuntimeStore } from "./session-store.js";
import { nowIso } from "./runtime-ids.js";
import { logger } from "../../infrastructure/runtime/logger.js";
/** A child is governed by liveness, not by a total wall-clock budget. */
export const SUBAGENT_HEARTBEAT_INTERVAL_MS = 5_000;
export const SUBAGENT_LEASE_DURATION_MS = 30_000;
/** Compatibility value for callers that still pass the old option. */
export const DEFAULT_PER_CHILD_TIMEOUT_MS = Number.POSITIVE_INFINITY;

export type SubagentLiveness = "healthy" | "stale" | "waiting" | "completed";

export interface SubagentTaskMetadata {
  state?: string;
  phase?: string;
  lastHeartbeatAt?: string;
  lastProgressAt?: string;
  leaseExpiresAt?: string;
  completedAt?: string;
  consumedAt?: string;
}

export interface PersistedSubagentResult {
  childSessionId: string;
  parentSessionId: string | null;
  status: string;
  summary: string | null;
  error: string | null;
  metadata: SubagentTaskMetadata | null;
}

export function getSubagentLiveness(
  status: string,
  metadata: SubagentTaskMetadata | null | undefined,
  now = Date.now(),
): SubagentLiveness {
  if (["completed", "failed", "cancelled", "interrupted"].includes(status))
    return "completed";
  if (metadata?.state === "waiting" || metadata?.phase === "waiting")
    return "waiting";
  const lease = metadata?.leaseExpiresAt ? Date.parse(metadata.leaseExpiresAt) : NaN;
  return Number.isFinite(lease) && lease >= now ? "healthy" : "stale";
}
/** Mirror of the existing subagent.delegate concurrency cap. */
export const DEFAULT_MAX_CONCURRENCY = 5;

export interface SubagentSpec {
  profileId: string;
  prompt: string;
  nodeId?: string | null;
  thinkingMode?: ThinkingMode;
  /** Display/diagnostic label. Defaults to the profileId. */
  label?: string;
}

export type SubagentBatchStatus =
  | "completed"
  | "failed"
  | "timeout"
  | "blocked";

export interface SubagentResult {
  spec: SubagentSpec;
  childSessionId: string | null;
  status: SubagentBatchStatus;
  summary: string | null;
  error: string | null;
}

export interface RunBatchOptions {
  maxConcurrency?: number;
  /** Deprecated compatibility field; total wall-clock time is not used. */
  perChildTimeoutMs?: number;
  abortSignal?: AbortSignal;
  /** Called synchronously right after each child session is created, before it
   *  runs. Use to configure per-child state (e.g. workspace root, title). */
  onChildCreated?: (childSessionId: string, spec: SubagentSpec) => void;
}

interface OrchestratorDeps {
  loop: AgentLoopRuntime;
  sessions: AgentSessionRuntime;
  store: AgentRuntimeStore;
}

// Getters defer binding reads to call time. This module and loop-runtime form
// an import cycle (loop-runtime reuses runChildToCompletion); reading the
// singletons at module-eval time would hit the temporal dead zone.
const defaultDeps: OrchestratorDeps = {
  get loop() {
    return agentLoopRuntime;
  },
  get sessions() {
    return agentSessionRuntime;
  },
  get store() {
    return agentRuntimeStore;
  },
};

export function readPersistedSubagentResult(
  childSessionId: string,
  expectedParentSessionId?: string | null,
  deps: OrchestratorDeps = defaultDeps,
): PersistedSubagentResult | null {
  const child = deps.store.tryGetSession(childSessionId);
  if (!child) return null;
  if (expectedParentSessionId !== undefined && child.parentSessionId !== expectedParentSessionId)
    return null;
  return {
    childSessionId,
    parentSessionId: child.parentSessionId ?? null,
    status: child.status,
    summary: child.resultSummary ?? null,
    error: child.blockedReason ?? null,
    metadata: (child.sessionMetadata?.subagentTask as SubagentTaskMetadata | undefined) ?? null,
  };
}

export function acknowledgePersistedSubagentResult(
  childSessionId: string,
  expectedParentSessionId?: string | null,
  deps: OrchestratorDeps = defaultDeps,
): boolean {
  const result = readPersistedSubagentResult(childSessionId, expectedParentSessionId, deps);
  if (!result || result.metadata?.consumedAt) return false;
  deps.store.updateSessionMetadata?.(childSessionId, {
    subagentTask: { ...(result.metadata ?? {}), consumedAt: nowIso() },
  });
  return true;
}

/** Child statuses the delegating parent can never resolve in-run: nothing drives
 *  another round or a resume while the delegate call is returning. Left alone they
 *  would register the child as pending forever and block parent acceptance. */
const UNRESOLVABLE_CHILD_STATUSES = new Set([
  "queued",
  "running",
  "interrupted",
]);

/** Finalize a child that ended in a non-terminal, non-waiting status. Waiting
 *  children (permission/form) stay untouched — the user can still answer them. */
function reapUnresolvableChild(
  childSessionId: string,
  timedOut: boolean,
  timeoutMs: number,
  deps: OrchestratorDeps,
): void {
  let child: ReturnType<AgentRuntimeStore["tryGetSession"]> | undefined;
  try {
    child = deps.store.tryGetSession(childSessionId);
  } catch {
    /* store unavailable — leave the child as-is */
  }
  if (!child || !UNRESOLVABLE_CHILD_STATUSES.has(child.status)) return;
  if (child.sessionMetadata?.runtimeControl) return;
  const reason = timedOut
    ? `Subagent timed out after ${timeoutMs}ms.`
    : `Subagent ended as ${child.status} without a terminal result.`;
  try {
    deps.store.updateSession(childSessionId, {
      status: "failed",
      updatedAt: nowIso(),
      blockedReason: reason,
    });
  } catch (err) {
    logger.warn(
      { childSessionId, err },
      "[subagent-orchestrator] failed to finalize child",
    );
  }
}

/**
 * Run a single already-created child session to completion with a wall-clock
 * timeout. Never throws — any failure/timeout is folded into the returned
 * SubagentResult. On timeout the child's own run is aborted and finalized (it
 * does not leak), but sibling work is untouched.
 */
export async function runChildToCompletion(
  childSessionId: string,
  spec: SubagentSpec,
  opts: {
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    input?: import("./contracts.js").StreamTurnRequest;
    resume?: boolean;
  } = {},
  deps: OrchestratorDeps = defaultDeps,
): Promise<SubagentResult> {
  const existing = deps.store.tryGetSession(childSessionId);
  if (
    !existing ||
    existing.sessionMetadata?.runtimeControl ||
    existing.sessionMetadata?.manualStop
  )
    return mapChildToResult(childSessionId, spec, false, deps);
  const controller = new AbortController();
  const startedAt = nowIso();
  const touch = (phase: string) => {
    deps.store.updateSessionMetadata?.(childSessionId, {
      subagentTask: {
        state: "running",
        phase,
        startedAt,
        lastHeartbeatAt: nowIso(),
        lastProgressAt: nowIso(),
        leaseExpiresAt: new Date(Date.now() + SUBAGENT_LEASE_DURATION_MS).toISOString(),
      },
    });
  };
  touch("starting");
  const heartbeat = setInterval(() => touch("running"), SUBAGENT_HEARTBEAT_INTERVAL_MS);

  const onParentAbort = () => {
    if (!controller.signal.aborted)
      controller.abort(new Error("Parent batch aborted."));
  };
  if (opts.abortSignal?.aborted) onParentAbort();
  else
    opts.abortSignal?.addEventListener("abort", onParentAbort, { once: true });

  const timer =
    typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
      ? setTimeout(() => {
          if (!controller.signal.aborted)
            controller.abort(new Error(`Subagent timed out after ${opts.timeoutMs}ms.`));
        }, opts.timeoutMs)
      : undefined;

  try {
    const stream = opts.resume
      ? deps.loop.streamContinue(childSessionId, opts.input ?? {}, controller.signal)
      : deps.loop.streamRun(childSessionId, opts.input ?? {}, controller.signal);
    for await (const _chunk of stream) {
      // Child persists its own messages/events; we only need the final status.
    }
  } catch (err) {
    logger.warn(
      { childSessionId, profileId: spec.profileId, err },
      "[subagent-orchestrator] child stream errored",
    );
  } finally {
    clearInterval(heartbeat);
    if (timer) clearTimeout(timer);
    opts.abortSignal?.removeEventListener("abort", onParentAbort);
    const finalChild = deps.store.tryGetSession(childSessionId);
    const finalState = finalChild?.status === "completed"
      ? "completed"
      : ["waiting_permission", "waiting_input", "paused"].includes(finalChild?.status ?? "")
        ? "waiting"
        : "failed";
    deps.store.updateSessionMetadata?.(childSessionId, {
      subagentTask: {
        state: finalState,
        phase: finalState,
        lastHeartbeatAt: nowIso(),
        lastProgressAt: nowIso(),
        completedAt: nowIso(),
      },
    });
  }

  return mapChildToResult(childSessionId, spec, false, deps);
}

function mapChildToResult(
  childSessionId: string,
  spec: SubagentSpec,
  timedOut: boolean,
  deps: OrchestratorDeps,
): SubagentResult {
  const child = deps.store.tryGetSession(childSessionId);
  if (!child) {
    return {
      spec,
      childSessionId,
      status: "failed",
      summary: null,
      error: "Child session not found.",
    };
  }
  const summary = child.resultSummary ?? null;
  const latestRun = deps.store.listRuns(childSessionId)[0];
  if (timedOut && child.status !== "completed") {
    return {
      spec,
      childSessionId,
      status: "timeout",
      summary,
      error: child.blockedReason ?? "Timed out.",
    };
  }
  if (child.status === "completed") {
    if (latestRun?.status === "blocked") {
      return {
        spec,
        childSessionId,
        status: "blocked",
        summary,
        error: child.blockedReason ?? latestRun.stopReason ?? "Blocked.",
      };
    }
    return { spec, childSessionId, status: "completed", summary, error: null };
  }
  return {
    spec,
    childSessionId,
    status: "failed",
    summary,
    error: child.blockedReason ?? `Ended as ${child.status}.`,
  };
}

/**
 * Deterministically fan out a batch of child agents and collect their results.
 *
 * Guarantees the model-driven path lacks:
 *  - bounded concurrency (slots, not all-at-once)
 *  - per-child wall-clock timeout (a hung child is aborted, not infinite)
 *  - failure isolation (one child failing/timing out never rejects the batch)
 *  - ordered results (output[i] corresponds to specs[i])
 *
 * Child sessions are created up front, synchronously and in order, before any
 * LLM work begins — so child registration cannot interleave with streaming.
 * runBatch NEVER throws; every outcome is a SubagentResult.
 */
export async function runBatch(
  parentSessionId: string,
  specs: SubagentSpec[],
  opts: RunBatchOptions = {},
  deps: OrchestratorDeps = defaultDeps,
): Promise<SubagentResult[]> {
  const maxConcurrency = opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const results = new Array<SubagentResult>(specs.length);

  // Phase 1: create all child sessions synchronously, in order. Any creation
  // failure becomes a terminal result for that slot (no session to run).
  const created = specs.map((spec, index) => {
    try {
      const child = deps.sessions.create({
        projectId: deps.store.getSession(parentSessionId).projectId,
        nodeId: spec.nodeId ?? null,
        profileId: spec.profileId,
        parentSessionId,
        prompt: spec.prompt,
        thinkingMode: spec.thinkingMode,
      });
      try {
        opts.onChildCreated?.(child.id, spec);
      } catch (hookErr) {
        logger.warn(
          { parentSessionId, childSessionId: child.id, err: hookErr },
          "[subagent-orchestrator] onChildCreated hook threw",
        );
      }
      return {
        index,
        spec,
        childSessionId: child.id as string | null,
        createError: null as string | null,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn(
        { parentSessionId, profileId: spec.profileId, err },
        "[subagent-orchestrator] child creation failed",
      );
      return { index, spec, childSessionId: null, createError: error };
    }
  });

  // Phase 2: run children through bounded concurrency slots.
  let cursor = 0;
  const runSlot = async (): Promise<void> => {
    while (cursor < created.length) {
      if (opts.abortSignal?.aborted) return;
      const item = created[cursor++];
      if (!item.childSessionId) {
        results[item.index] = {
          spec: item.spec,
          childSessionId: null,
          status: "failed",
          summary: null,
          error: item.createError ?? "Child session not created.",
        };
        continue;
      }
      results[item.index] = await runChildToCompletion(
        item.childSessionId,
        item.spec,
        { abortSignal: opts.abortSignal },
        deps,
      );
    }
  };

  const workers = Array.from(
    { length: Math.min(maxConcurrency, created.length) },
    runSlot,
  );
  await Promise.allSettled(workers);

  // Fill any slots skipped by an aborted batch; their sessions were created but
  // never driven, so finalize them instead of leaving 'running' zombies.
  for (let i = 0; i < specs.length; i++) {
    if (!results[i]) {
      const childSessionId = created[i]?.childSessionId ?? null;
      if (childSessionId) {
        try {
          deps.store.updateSession(childSessionId, {
            status: "failed",
            updatedAt: nowIso(),
            blockedReason: "Batch aborted before execution.",
          });
        } catch (err) {
          logger.warn(
            { parentSessionId, childSessionId, err },
            "[subagent-orchestrator] failed to finalize skipped child",
          );
        }
      }
      results[i] = {
        spec: specs[i],
        childSessionId,
        status: "failed",
        summary: null,
        error: "Batch aborted before execution.",
      };
    }
  }

  logger.info(
    {
      parentSessionId,
      total: specs.length,
      byStatus: tallyStatus(results),
      maxConcurrency,
    },
    "[subagent-orchestrator] batch complete",
  );
  return results;
}

function tallyStatus(
  results: SubagentResult[],
): Record<SubagentBatchStatus, number> {
  const tally: Record<SubagentBatchStatus, number> = {
    completed: 0,
    failed: 0,
    timeout: 0,
    blocked: 0,
  };
  for (const r of results) if (r) tally[r.status]++;
  return tally;
}

export const subagentOrchestrator = { runBatch, runChildToCompletion };
