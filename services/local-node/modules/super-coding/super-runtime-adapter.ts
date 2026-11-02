/**
 * Infrastructure adapter for the super coding service.
 *
 * Nothing here is new capability: the graph lives in session metadata, children
 * are started with the existing configured-subagent path, messages go through
 * the existing input queue and events through the existing event service. Rev
 * is compared before writing, so two writers cannot silently overwrite.
 */
import {
  SUPER_DEFAULT_CONFIG,
  isSuperNodeWaiting,
  resolveSuperModel,
  type SuperCodingConfig,
  type SuperGraph,
  type SuperTaskType,
} from "../../../../packages/contracts/super-coding.js";
import type {
  RuntimeEventType,
  ToolExecutionInput,
} from "../agent-runtime/contracts.js";
import { interruptAgentSessionsAndWait } from "../agent-runtime/agent-stream-proxy.js";
import { agentEventService } from "../agent-runtime/event-service.js";
import { inputQueueRuntime } from "../agent-runtime/input-queue-runtime.js";
import { runCoordinator } from "../agent-runtime/run-coordinator.js";
import { nowIso } from "../agent-runtime/runtime-ids.js";
import { emitRuntimeBusEvent } from "../agent-runtime/runtime-bus-bridge.js";
import { agentRuntimeStore } from "../agent-runtime/session-store.js";
import { agentSessionRuntime } from "../agent-runtime/session-runtime.js";
import { runtimeFacade } from "../agent-runtime/sidecar/runtime-facade.js";
import { subagentProfileSchema } from "../agent-runtime/subagent-config.js";
import { createConfiguredSubagent } from "../agent-runtime/subagent-delegation.js";
import {
  readPersistedSubagentResult,
  runChildToCompletion,
} from "../agent-runtime/subagent-orchestrator.js";
import {
  getGlobalConfigForRuntime,
} from "../../infrastructure/runtime/config/config-store.js";
import { logger } from "../../infrastructure/runtime/logger.js";
import { SuperGraphConflictError, type SuperServiceDeps } from "./super-service.js";

export { SuperGraphConflictError } from "./super-service.js";

export interface SuperRuntimeAdapterOptions {
  /**
   * Called when a super child reaches a terminal or waiting state. The adapter
   * starts children in the background, so the service's settle handler is wired
   * here instead of being polled.
   */
  onChildSettled?: (input: {
    parentSessionId: string;
    childSessionId: string;
    status: string;
    summary?: string | null;
  }) => Promise<void> | void;
}

function storedGraph(sessionId: string): SuperGraph | null {
  const session = agentRuntimeStore.tryGetSession(sessionId);
  const value = session?.sessionMetadata?.superGraph as SuperGraph | undefined;
  return value ? structuredClone(value) : null;
}

/**
 * The agent-runtime `RuntimeEventType` enum predates super events; the shared
 * contract owns their names. Keep the single unavoidable cast here.
 */
function superEventType(kind: "snapshot" | "nodes"): RuntimeEventType {
  return (kind === "snapshot" ? "super.snapshot" : "super.nodes") as unknown as RuntimeEventType;
}

/** Settings own the pool; an unset pool keeps the default budget. */
function superCodingConfig(): SuperCodingConfig {
  return getGlobalConfigForRuntime().superCoding ?? SUPER_DEFAULT_CONFIG;
}

/**
 * Ordered routes first, then the pool default. An unconfigured pool returns an
 * empty model, which makes the child inherit the parent session's own model;
 * the previous global-provider fallback ignored the model the user had selected.
 */
function routeModel(taskType: SuperTaskType): string {
  return resolveSuperModel(superCodingConfig(), taskType).model;
}

/** Wake a completed Super parent after a child settles and the graph is live. */
async function wakeCompletedParent(input: {
  parentSessionId: string;
  childSessionId: string;
  status: string;
  summary?: string | null;
}): Promise<void> {
  const parent = agentRuntimeStore.tryGetSession(input.parentSessionId);
  if (!parent || parent.status !== "completed") return;
  if (parent.sessionMetadata?.manualStop || parent.sessionMetadata?.runtimeControl) return;
  const graph = storedGraph(input.parentSessionId);
  if (!graph) return;
  // A failed graph still reports the failure that ended it; otherwise the
  // parent would never learn that the graph died and could not replan.
  const reportingFailure = graph.phase === "failed" && input.status === "failed";
  if (graph.phase !== "running" && !reportingFailure) return;
  if (!graph.nodes.some((node) => node.status !== "archived")) return;

  const failedNode = reportingFailure
    ? graph.nodes.find((node) => node.childSessionId === input.childSessionId)
    : undefined;
  const message = [
    "[Super internal continuation]",
    `Child node ${failedNode ? failedNode.id : input.childSessionId} settled as ${input.status}.`,
    reportingFailure
      ? `The graph failed at that node${graph.phaseError ? ` (${graph.phaseError})` : ""}. Every queued node downstream of it was failed with it; nothing can start and \`super.close\` is a no-op.`
      : "",
    input.summary ? `Summary: ${input.summary}` : "",
    reportingFailure
      ? "Decide now: report the failure with its evidence, or reopen the graph with `super.plan` for the work that must continue (use new node ids; the cascade already failed the old downstream nodes)."
      : "Continue the current Super graph from its latest snapshot. Do not repeat settled work; execute or plan only the remaining nodes, and do not close the graph while required work remains.",
  ].filter(Boolean).join("\n");
  // Runtime scaffolding, not a turn the user wrote: the marker keeps it out of
  // the transcript on both the queue and the direct submit path.
  const messageSource = "system_injection" as const;

  if (runtimeFacade.streamMode() === "authoritative") {
    await inputQueueRuntime.enqueue(input.parentSessionId, { message, messageSource });
    const dispatched = await runCoordinator.dispatchQueuedInput(input.parentSessionId);
    if (!dispatched)
      logger.warn(
        { parentSessionId: input.parentSessionId, childSessionId: input.childSessionId },
        "[super] parent wake-up remained queued",
      );
    return;
  }

  await runCoordinator.submit(
    input.parentSessionId,
    { message, messageSource },
    `super-parent-wake:${input.childSessionId}:${graph.rev}`,
    "continue",
  );
}

export function createSuperRuntimeDeps(
  options: SuperRuntimeAdapterOptions = {},
): SuperServiceDeps {
  return {
    async readGraph(sessionId) {
      return storedGraph(sessionId);
    },

    async writeGraph(graph, expectedRev) {
      const current = storedGraph(graph.sessionId);
      const actualRev = current?.rev ?? null;
      if ((actualRev ?? -1) !== expectedRev)
        throw new SuperGraphConflictError(graph.sessionId, expectedRev, actualRev);
      agentRuntimeStore.updateSessionMetadata(graph.sessionId, {
        superGraph: structuredClone(graph),
      });
    },

    publish(kind, graph) {
      const payload =
        kind === "snapshot"
          ? { graph }
          : {
              nodes: graph.nodes,
              edges: graph.edges,
              rev: graph.rev,
              phase: graph.phase,
              verifyNodeId: graph.verifyNodeId,
            };
      // The card listens on the runtime event bus, so the same payload is
      // emitted there; the RuntimeEvent append keeps the durable audit trail.
      emitRuntimeBusEvent({
        type: kind === "snapshot" ? "super.snapshot" : "super.nodes",
        sessionId: graph.sessionId,
        patch: payload as Record<string, unknown>,
      });
      agentEventService.append({
        sessionId: graph.sessionId,
        type: superEventType(kind),
        summary:
          kind === "snapshot"
            ? `Super graph ${graph.phase} (rev ${graph.rev})`
            : `${graph.nodes.length} super node(s) (rev ${graph.rev})`,
        payload,
        visibility: "user_visible",
      });
    },

    async startChild({ parentSessionId, node, brief }) {
      const input: ToolExecutionInput = {
        sessionId: parentSessionId,
        runId: null,
        stepId: null,
        toolCallId: `super:${node.id}`,
        toolId: "super.plan",
        category: "task",
        mutability: "task",
        args: {},
      };
      // Empty is the only inheritance signal. Validate nonempty scopes with
      // the same schema as ordinary delegation; never drop an invalid boundary.
      const scope = node.scope.length
        ? subagentProfileSchema.shape.writeScope.parse(node.scope)
        : undefined;
      const { child, spec } = await createConfiguredSubagent(input, {
        prompt: brief,
        name: node.title.slice(0, 80),
        deliverable: node.deliverable,
        acceptanceCriteria: node.acceptance.length ? node.acceptance : undefined,
        profile: {
          ...(node.model ? { model: node.model } : {}),
          thinkingMode: "deep",
          ...(scope ? { writeScope: scope } : {}),
        },
      });
      void (async () => {
        let outcome: Awaited<ReturnType<typeof runChildToCompletion>>;
        try {
          outcome = await runChildToCompletion(child.id, spec, {
            input: { reasoningEffort: node.effort },
          });
        } catch (error) {
          // The orchestrator normally folds failures into its result. Keep a
          // defensive terminal outcome for an unexpected rejection.
          outcome = {
            spec,
            childSessionId: child.id,
            status: "failed",
            summary: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        try {
          // Batch results fold waiting sessions into "failed". Super keeps
          // those children live so permission/input/paused work can continue.
          const persisted = readPersistedSubagentResult(child.id, parentSessionId);
          const childStatus = persisted?.status ?? outcome.status;
          const waiting = isSuperNodeWaiting(childStatus);
          await options.onChildSettled?.({
            parentSessionId,
            childSessionId: child.id,
            status: waiting ? childStatus : outcome.status,
            summary: waiting
              ? persisted?.summary ?? persisted?.error ?? outcome.summary
              : outcome.summary ?? outcome.error,
          });
        } catch (error) {
          // A persistence/event failure is not a child failure. Keep the
          // notification failure visible rather than sending a false failure.
          logger.warn(
            { parentSessionId, childSessionId: child.id, error },
            "[super] child settlement notification failed",
          );
        }
      })();
      return { childSessionId: child.id };
    },

    wakeParent: wakeCompletedParent,

    async deliverToChild({ childSessionId, text }) {
      if (!inputQueueRuntime.enabled())
        throw new Error(
          "Super messages need the authoritative runtime input queue.",
        );
      await inputQueueRuntime.enqueue(childSessionId, { message: text });
      return "queued";
    },

    async stopChild(childSessionId, reason) {
      await interruptAgentSessionsAndWait([childSessionId], reason);
      if (runtimeFacade.streamMode() === "authoritative")
        await runtimeFacade.stopSessionAuthoritative(
          childSessionId,
          "cancelled",
          reason,
        );
      else agentSessionRuntime.interrupt(childSessionId);
    },

    modelFor(taskType) {
      return routeModel(taskType);
    },

    /** Children inherit the primary agent's forced deep/high tier. */
    effortFor() {
      return "high";
    },

    now() {
      return nowIso();
    },
  };
}
