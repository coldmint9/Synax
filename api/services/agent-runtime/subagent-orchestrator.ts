import type { AgentProfileKind, ThinkingMode } from './contracts.js';
import { agentLoopRuntime, type AgentLoopRuntime } from './loop-runtime.js';
import { agentSessionRuntime, type AgentSessionRuntime } from './session-runtime.js';
import { agentRuntimeStore, type AgentRuntimeStore } from './session-store.js';
import { nowIso } from './runtime-ids.js';
import { logger } from '../../lib/logger.js';

/** Default per-child wall-clock budget. Large-repo explorers run bash + read
 *  many files, so the ceiling is generous; callers may override. */
export const DEFAULT_PER_CHILD_TIMEOUT_MS = 180_000;
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

export type SubagentBatchStatus = 'completed' | 'failed' | 'timeout' | 'blocked';

export interface SubagentResult {
  spec: SubagentSpec;
  childSessionId: string | null;
  status: SubagentBatchStatus;
  summary: string | null;
  error: string | null;
}

export interface RunBatchOptions {
  maxConcurrency?: number;
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
  get loop() { return agentLoopRuntime; },
  get sessions() { return agentSessionRuntime; },
  get store() { return agentRuntimeStore; },
};

/**
 * Run a single already-created child session to completion with a wall-clock
 * timeout. Never throws — any failure/timeout is folded into the returned
 * SubagentResult. On timeout the child's own run is aborted (it does not leak),
 * but sibling work is untouched.
 */
export async function runChildToCompletion(
  childSessionId: string,
  spec: SubagentSpec,
  opts: { timeoutMs: number; abortSignal?: AbortSignal } = { timeoutMs: DEFAULT_PER_CHILD_TIMEOUT_MS },
  deps: OrchestratorDeps = defaultDeps,
): Promise<SubagentResult> {
  const controller = new AbortController();
  let timedOut = false;

  const onParentAbort = () => {
    if (!controller.signal.aborted) controller.abort(new Error('Parent batch aborted.'));
  };
  if (opts.abortSignal?.aborted) onParentAbort();
  else opts.abortSignal?.addEventListener('abort', onParentAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    if (!controller.signal.aborted) controller.abort(new Error(`Subagent timed out after ${opts.timeoutMs}ms.`));
  }, opts.timeoutMs);

  try {
    for await (const _chunk of deps.loop.streamRun(childSessionId, {}, controller.signal)) {
      // Child persists its own messages/events; we only need the final status.
    }
  } catch (err) {
    logger.warn({ childSessionId, profileId: spec.profileId, timedOut, err },
      '[subagent-orchestrator] child stream errored');
  } finally {
    clearTimeout(timer);
    opts.abortSignal?.removeEventListener('abort', onParentAbort);
  }

  return mapChildToResult(childSessionId, spec, timedOut, deps);
}

function mapChildToResult(
  childSessionId: string,
  spec: SubagentSpec,
  timedOut: boolean,
  deps: OrchestratorDeps,
): SubagentResult {
  const child = deps.store.tryGetSession(childSessionId);
  if (!child) {
    return { spec, childSessionId, status: 'failed', summary: null, error: 'Child session not found.' };
  }
  const summary = child.resultSummary ?? null;
  if (timedOut && child.status !== 'completed') {
    return { spec, childSessionId, status: 'timeout', summary, error: child.blockedReason ?? 'Timed out.' };
  }
  if (child.status === 'completed') {
    return { spec, childSessionId, status: 'completed', summary, error: null };
  }
  if (child.status === 'blocked') {
    return { spec, childSessionId, status: 'blocked', summary, error: child.blockedReason ?? 'Blocked.' };
  }
  return { spec, childSessionId, status: 'failed', summary, error: child.blockedReason ?? `Ended as ${child.status}.` };
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
  const perChildTimeoutMs = opts.perChildTimeoutMs ?? DEFAULT_PER_CHILD_TIMEOUT_MS;
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
        logger.warn({ parentSessionId, childSessionId: child.id, err: hookErr },
          '[subagent-orchestrator] onChildCreated hook threw');
      }
      return { index, spec, childSessionId: child.id as string | null, createError: null as string | null };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn({ parentSessionId, profileId: spec.profileId, err },
        '[subagent-orchestrator] child creation failed');
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
          spec: item.spec, childSessionId: null, status: 'failed',
          summary: null, error: item.createError ?? 'Child session not created.',
        };
        continue;
      }
      results[item.index] = await runChildToCompletion(
        item.childSessionId, item.spec,
        { timeoutMs: perChildTimeoutMs, abortSignal: opts.abortSignal },
        deps,
      );
    }
  };

  const workers = Array.from({ length: Math.min(maxConcurrency, created.length) }, runSlot);
  await Promise.allSettled(workers);

  // Fill any slots skipped by an aborted batch.
  for (let i = 0; i < specs.length; i++) {
    if (!results[i]) {
      results[i] = {
        spec: specs[i], childSessionId: created[i]?.childSessionId ?? null,
        status: 'failed', summary: null, error: 'Batch aborted before execution.',
      };
    }
  }

  logger.info(
    { parentSessionId, total: specs.length, byStatus: tallyStatus(results), perChildTimeoutMs, maxConcurrency },
    '[subagent-orchestrator] batch complete',
  );
  return results;
}

function tallyStatus(results: SubagentResult[]): Record<SubagentBatchStatus, number> {
  const tally: Record<SubagentBatchStatus, number> = { completed: 0, failed: 0, timeout: 0, blocked: 0 };
  for (const r of results) if (r) tally[r.status]++;
  return tally;
}

export const subagentOrchestrator = { runBatch, runChildToCompletion };


