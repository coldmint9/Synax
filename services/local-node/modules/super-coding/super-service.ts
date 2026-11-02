/**
 * Super coding use cases: plan, start, message, close, stop and child settle.
 *
 * The service knows nothing about sessions, stores or subagent runtimes: every
 * effect arrives through `SuperServiceDeps`, so tests run the full lifecycle on
 * in-memory fakes and the runtime adapter stays the only infrastructure edge.
 */
import {
  SUPER_MAX_BRIEF_CHARS,
  SUPER_MAX_MESSAGE_CHARS,
  SUPER_MAX_MESSAGES_PER_NODE,
  createEmptySuperGraph,
  isSuperNodeActive,
  isSuperNodeWaiting,
  type SuperCommandResult,
  type SuperGraph,
  type SuperNode,
  type SuperTaskType,
} from "../../../../packages/contracts/super-coding.js";
import {
  SUPER_VERIFY_NODE_ID,
  appendNodeMessage,
  admitNode,
  clearGraphFailure,
  closeGraph,
  dependenciesOf,
  failGraph,
  graphNode,
  markPhase,
  occupyingNodeCount,
  retryNode,
  reviveFailedNode,
  setNodeStatus,
  upsertEdge,
  upsertNode,
} from "./super-graph.js";
import { detectToolCallTextArtifact } from "./tool-call-text.js";

/** A node summary is a pointer, never a transcript (architecture §5/§6). */
export const SUPER_MAX_SUMMARY_CHARS = 800;

/**
 * One automatic retry, only for failures that are about the transport rather
 * than the work: a gateway that drops a stream says nothing about whether the
 * task can be done, while a failed acceptance check or a tool-call artifact
 * would just repeat. A second identical failure ends the graph.
 */
export const SUPER_MAX_NODE_RETRIES = 1;

const TRANSIENT_FAILURE = new RegExp(
  [
    "HttpError",
    "error decoding response body",
    "ResponseError",
    "Response ended while in_progress",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "socket hang up",
    "fetch failed",
    "upstream (?:error|refused|timeout)",
    "\\b429\\b",
    "(?:status|code)[:=\\s]*5\\d\\d\\b",
  ].join("|"),
  "i",
);

/** True when a child's failure text names a transport/provider fault. */
export function isTransientProviderFailure(
  text: string | null | undefined,
): boolean {
  return typeof text === "string" && TRANSIENT_FAILURE.test(text);
}

/** Persistence adapters use this to distinguish CAS conflicts from IO failures. */
export class SuperGraphConflictError extends Error {
  constructor(
    readonly sessionId: string,
    readonly expectedRev: number,
    readonly actualRev: number | null,
  ) {
    super(
      `Super graph ${sessionId} changed (expected rev ${expectedRev}, found ${actualRev ?? "none"}).`,
    );
    this.name = "SuperGraphConflictError";
  }
}

const MAX_SETTLEMENT_ATTEMPTS = 3;

export interface NewSuperNodeInput {
  id: string;
  title: string;
  taskType: SuperTaskType;
  objective: string;
  deliverable: string;
  acceptance?: string[];
  scope?: string[];
  /** ids this node depends on */
  requires?: string[];
}

export interface SuperService {
  getGraph(sessionId: string): Promise<SuperGraph | null>;
  plan(input: {
    sessionId: string;
    nodes: NewSuperNodeInput[];
  }): Promise<SuperCommandResult>;
  start(input: { sessionId: string; nodeId: string }): Promise<SuperCommandResult>;
  /** Start every runnable node until the graph is blocked or saturated. */
  advance(sessionId: string): Promise<SuperCommandResult>;
  message(input: {
    sessionId: string;
    nodeId: string;
    from: "main" | "user" | "child";
    text: string;
  }): Promise<SuperCommandResult>;
  close(input: { sessionId: string }): Promise<SuperCommandResult>;
  stop(input: { sessionId: string }): Promise<SuperCommandResult>;
  onChildSettled(input: {
    parentSessionId: string;
    childSessionId: string;
    status: string;
    summary?: string | null;
  }): Promise<void>;
}

export type SuperServiceDeps = {
  readGraph(sessionId: string): Promise<SuperGraph | null>;
  /** Throw SuperGraphConflictError when expectedRev no longer matches. */
  writeGraph(graph: SuperGraph, expectedRev: number): Promise<void>;
  publish(kind: "snapshot" | "nodes", graph: SuperGraph): void;
  startChild(input: {
    parentSessionId: string;
    node: SuperNode;
    brief: string;
  }): Promise<{ childSessionId: string }>;
  deliverToChild(input: {
    childSessionId: string;
    text: string;
  }): Promise<"queued" | "delivered">;
  stopChild(childSessionId: string, reason: string): Promise<void>;
  /** Wake a completed parent so it can observe the settlement and continue the graph. */
  wakeParent?(input: {
    parentSessionId: string;
    childSessionId: string;
    status: string;
    summary?: string | null;
  }): Promise<void>;
  modelFor(taskType: SuperTaskType): string;
  effortFor(): "high" | "xhigh" | "max";
  now(): string;
};

const terminalChildStatuses = new Set([
  "failed",
  "cancelled",
  "interrupted",
  "timeout",
  // A completed session can still have its last run blocked. It is terminal
  // from the graph's point of view, but it is not a successful node.
  "blocked",
]);

function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unique(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])];
}

/**
 * Serializes the read-modify-write use cases of one session.
 *
 * Automatic advancing starts children from several entry points (plan, close,
 * child settlement), and each start commits a new graph revision. Without this
 * queue two of them read the same revision and the second write is rejected.
 */
function createSessionQueue() {
  const tails = new Map<string, Promise<unknown>>();
  return function serialize<T>(
    sessionId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = tails.get(sessionId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.catch(() => undefined);
    tails.set(sessionId, tail);
    void tail.then(() => {
      if (tails.get(sessionId) === tail) tails.delete(sessionId);
    });
    return next;
  };
}

/**
 * Brief sent to a child: objective, deliverable, acceptance, scope and at most
 * two upstream summaries, truncated to SUPER_MAX_BRIEF_CHARS. The transcript is
 * never copied, so per-node cost stays bounded.
 */
export function buildNodeBrief(graph: SuperGraph, node: SuperNode): string {
  const upstream = dependenciesOf(graph, node.id)
    .map((id) => graphNode(graph, id))
    .filter((entry): entry is SuperNode => Boolean(entry?.summary))
    .slice(0, 2)
    .map((entry) => `- ${entry.id}: ${entry.summary}`);
  const sections = [
    `Objective: ${node.objective}`,
    `Deliverable: ${node.deliverable}`,
    node.acceptance.length
      ? `Acceptance:\n${node.acceptance.map((item) => `- ${item}`).join("\n")}`
      : "",
    node.scope.length
      ? `Write scope:\n${node.scope.map((item) => `- ${item}`).join("\n")}`
      : "",
    upstream.length ? `Upstream summaries:\n${upstream.join("\n")}` : "",
  ].filter(Boolean);
  return truncate(sections.join("\n\n"), SUPER_MAX_BRIEF_CHARS);
}

/** The one verification node `close` reuses; it has no prerequisites. */
function createVerifyNode(
  deps: SuperServiceDeps,
  graph: SuperGraph,
  now: string,
): SuperNode {
  const finished = graph.nodes.filter(
    (node) => node.status === "completed" || node.status === "failed",
  ).length;
  return {
    id: graph.verifyNodeId ?? SUPER_VERIFY_NODE_ID,
    title: "Final verification",
    taskType: "verify",
    objective: `Verify the delivered work of the super graph in session ${graph.sessionId} (${finished} finished nodes).`,
    deliverable:
      "A verification verdict that states what was checked, the evidence used and any remaining gap.",
    acceptance: [
      "Check the delivered result against each archived node's acceptance criteria.",
      "Report failures with the exact evidence instead of a general impression.",
    ],
    scope: [],
    status: "queued",
    depth: 0,
    model: deps.modelFor("verify"),
    effort: deps.effortFor(),
    childSessionId: null,
    messages: 0,
    summary: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

function candidateNode(input: {
  node: NewSuperNodeInput;
  depth: number;
  deps: SuperServiceDeps;
  now: string;
}): SuperNode {
  const { node, depth, deps, now } = input;
  return {
    id: node.id,
    title: node.title,
    taskType: node.taskType,
    objective: node.objective,
    deliverable: node.deliverable,
    acceptance: [...(node.acceptance ?? [])],
    scope: [...(node.scope ?? [])],
    status: "queued",
    depth,
    model: deps.modelFor(node.taskType),
    effort: deps.effortFor(),
    childSessionId: null,
    messages: 0,
    summary: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function createSuperService(deps: SuperServiceDeps): SuperService {
  /** Persisted revision the next write is allowed to replace; -1 = no graph. */
  async function load(
    sessionId: string,
  ): Promise<{ graph: SuperGraph; expectedRev: number }> {
    const stored = await deps.readGraph(sessionId);
    return stored
      ? { graph: stored, expectedRev: stored.rev }
      : {
          graph: createEmptySuperGraph({ sessionId, now: deps.now() }),
          expectedRev: -1,
        };
  }

  async function commit(
    graph: SuperGraph,
    expectedRev: number,
    kind: "snapshot" | "nodes",
  ): Promise<SuperCommandResult> {
    try {
      await deps.writeGraph(graph, expectedRev);
    } catch (error) {
      const conflict = error instanceof SuperGraphConflictError;
      return {
        ok: false,
        code: conflict ? "REV_CONFLICT" : "WRITE_FAILED",
        message: conflict
          ? `The super graph changed while writing (${errorMessage(error)}); re-read the snapshot and retry.`
          : `Could not write the super graph: ${errorMessage(error)}`,
      };
    }
    deps.publish(kind, graph);
    return { ok: true, graph };
  }

  function missingGraph(): SuperCommandResult {
    return {
      ok: false,
      code: "NO_GRAPH",
      message: "This session has no super graph; plan nodes first.",
    };
  }

  const raw: SuperService = {
    async getGraph(sessionId) {
      return deps.readGraph(sessionId);
    },

    async plan({ sessionId, nodes }) {
      const { graph: stored, expectedRev } = await load(sessionId);
      if (stored.phase === "stopped" || stored.phase === "done")
        return {
          ok: false,
          code: "GRAPH_TERMINAL",
          message: `The super graph is ${stored.phase}; plan a new graph instead of adding nodes to it.`,
          graph: stored,
        };
      let graph = stored;
      let changed = false;
      // A rejection after some nodes were admitted still commits that prefix.
      const rejectAndWrite = async (
        rejection: SuperCommandResult,
        prefix: SuperGraph,
      ): Promise<SuperCommandResult> => {
        if (!changed) return rejection;
        const written = await commit(prefix, expectedRev, "nodes");
        if (written.ok) {
          try {
            const advanced = await raw.advance(sessionId);
            if (advanced.graph) return { ...rejection, graph: advanced.graph };
          } catch {
            /* keep the rejection and the written prefix */
          }
        }
        return { ...rejection, graph: written.graph ?? prefix };
      };
      for (const input of nodes) {
        const requires = unique(input.requires);
        const depths = requires.map((id) => graphNode(graph, id)?.depth ?? 0);
        const depth = requires.length ? 1 + Math.max(...depths) : 0;
        const now = deps.now();
        const existing = graphNode(graph, input.id);
        // Re-planning a failed node revives it in place: the failure cascade
        // already failed its dependents, so they come back with it instead of
        // forcing a rebuild under new ids.
        if (existing?.status === "failed") {
          const pending = dependenciesOf(graph, input.id).filter(
            (id) => graphNode(graph, id)?.status !== "completed",
          );
          if (pending.length)
            return await rejectAndWrite(
              {
                ok: false,
                code: "DEPS_PENDING",
                message: `Reviving ${input.id} needs its prerequisites completed first: ${pending.join(", ")}.`,
                graph,
              },
              graph,
            );
          graph = reviveFailedNode(graph, {
            nodeId: input.id,
            spec: {
              title: input.title,
              taskType: input.taskType,
              objective: input.objective,
              deliverable: input.deliverable,
              acceptance: [...(input.acceptance ?? [])],
              scope: [...(input.scope ?? [])],
              model: deps.modelFor(input.taskType),
              effort: deps.effortFor(),
            },
            now,
          });
          changed = true;
          continue;
        }
        const node = candidateNode({ node: input, depth, deps, now });
        const admission = admitNode(graph, node, requires);
        if (!admission.ok) {
          return await rejectAndWrite(
            {
              ok: false,
              code: admission.code,
              message: `${admission.message} ${admission.action}`,
              graph,
            },
            graph,
          );
        }
        graph = upsertNode(graph, node, now);
        for (const id of requires)
          graph = upsertEdge(
            graph,
            {
              id: `dep:${id}->${node.id}`,
              from: id,
              to: node.id,
              kind: "dependency",
              count: 1,
            },
            now,
          );
        changed = true;
      }
      if (!changed) return { ok: true, graph };
      // Planning on a failed graph is the explicit restart: the failure already
      // cascaded, so admitting replacement work reopens the graph deliberately
      // instead of leaving it half-open behind a failed dependency.
      if (graph.phase === "failed")
        graph = clearGraphFailure(graph, deps.now());
      // Creation publishes a snapshot: the card may have no graph yet, and a
      // node delta alone cannot reconstruct phase/budget.
      const written = await commit(graph, expectedRev, "snapshot");
      if (!written.ok) return written;
      // Planning succeeded; a node that failed to start carries its own error.
      try {
        const advanced = await raw.advance(sessionId);
        return advanced.graph ? { ok: true, graph: advanced.graph } : written;
      } catch {
        return written;
      }
    },

    async start({ sessionId, nodeId }) {
      const stored = await deps.readGraph(sessionId);
      if (!stored) return missingGraph();
      if (
        stored.phase === "stopped" ||
        stored.phase === "done" ||
        stored.phase === "failed"
      )
        return {
          ok: false,
          code: "GRAPH_TERMINAL",
          message: `The super graph is ${stored.phase}; no new child may start.`,
        };
      const node = graphNode(stored, nodeId);
      if (!node)
        return {
          ok: false,
          code: "NODE_NOT_FOUND",
          message: `Node ${nodeId} is not in this graph.`,
        };
      if (node.status !== "queued")
        return {
          ok: false,
          code: "NOT_QUEUED",
          message: `Node ${nodeId} is ${node.status}; only queued nodes start.`,
        };
      const pending = dependenciesOf(stored, nodeId).filter(
        (id) => graphNode(stored, id)?.status !== "completed",
      );
      if (pending.length)
        return {
          ok: false,
          code: "DEPS_PENDING",
          message: `Wait for ${pending.join(", ")} to complete before starting ${nodeId}.`,
        };
      if (occupyingNodeCount(stored) >= stored.maxConcurrent)
        return {
          ok: false,
          code: "CONCURRENCY_LIMIT",
          message: `All ${stored.maxConcurrent} concurrent slots are running; wait for a node to finish.`,
        };

      let childSessionId: string;
      try {
        const started = await deps.startChild({
          parentSessionId: sessionId,
          node,
          brief: buildNodeBrief(stored, node),
        });
        childSessionId = started.childSessionId;
      } catch (error) {
        const failed = setNodeStatus(
          stored,
          nodeId,
          {
            status: "failed",
            error: truncate(errorMessage(error), SUPER_MAX_SUMMARY_CHARS),
          },
          deps.now(),
        );
        let failureGraph: SuperGraph | undefined;
        try {
          await deps.writeGraph(failed, stored.rev);
          deps.publish("nodes", failed);
          failureGraph = failed;
        } catch {
          /* Keep the start error; the graph stays queued for a retry. */
        }
        return {
          ok: false,
          code: "START_FAILED",
          message: errorMessage(error),
          ...(failureGraph ? { graph: failureGraph } : {}),
        };
      }

      const now = deps.now();
      let graph = setNodeStatus(
        stored,
        nodeId,
        { status: "running", childSessionId },
        now,
      );
      graph = markPhase(graph, "running", now);
      const written = await commit(graph, stored.rev, "nodes");
      if (!written.ok) {
        // Child creation is an external effect, not part of the graph CAS.
        // A losing start must release that child before the caller may retry.
        try {
          await deps.stopChild(
            childSessionId,
            `Super node ${nodeId} start was not committed (${written.code}).`,
          );
        } catch (error) {
          return {
            ...written,
            message: `${written.message} Cleanup of child ${childSessionId} failed: ${errorMessage(error)}`,
          };
        }
      }
      return written;
    },

    async message({ sessionId, nodeId, from, text }) {
      const stored = await deps.readGraph(sessionId);
      if (!stored) return missingGraph();
      if (stored.phase === "failed")
        return {
          ok: false,
          code: "GRAPH_TERMINAL",
          message: `The super graph failed (${stored.phaseError ?? "a node failed"}); plan a new graph instead.`,
        };
      const node = graphNode(stored, nodeId);
      if (!node)
        return {
          ok: false,
          code: "NODE_NOT_FOUND",
          message: `Node ${nodeId} is not in this graph.`,
        };
      if (node.status === "archived")
        return {
          ok: false,
          code: "ARCHIVED",
          message: `Node ${nodeId} is archived; plan a new node instead.`,
        };
      // A failed child is gone: the message would be queued into a session that
      // never runs again and would still spend the node's message budget.
      if (node.status === "failed")
        return {
          ok: false,
          code: "NODE_FAILED",
          message: `Node ${nodeId} failed (${node.error ?? "no reason recorded"}); plan a replacement node instead of messaging it.`,
        };
      if (node.messages >= SUPER_MAX_MESSAGES_PER_NODE)
        return {
          ok: false,
          code: "MESSAGE_LIMIT",
          message: `Node ${nodeId} already received ${node.messages} messages (limit ${SUPER_MAX_MESSAGES_PER_NODE}).`,
        };
      if (!node.childSessionId)
        return {
          ok: false,
          code: "NOT_STARTED",
          message: `Node ${nodeId} has no child session yet; start it first.`,
        };
      const body = truncate(text.trim(), SUPER_MAX_MESSAGE_CHARS);
      if (!body)
        return {
          ok: false,
          code: "EMPTY_MESSAGE",
          message: "Send a non-empty message.",
        };
      try {
        await deps.deliverToChild({
          childSessionId: node.childSessionId,
          text: body,
        });
      } catch (error) {
        return {
          ok: false,
          code: "MESSAGE_REJECTED",
          message: `Delivery to ${nodeId} was rejected: ${errorMessage(error)}`,
        };
      }
      const now = deps.now();
      // Bounded per-node log: the card can show what was delivered without a
      // second storage system, and the cap matches the message budget.
      const graph = appendNodeMessage(
        stored,
        nodeId,
        { from, text: body, at: now, delivery: "queued" },
        now,
      );
      return commit(graph, stored.rev, "nodes");
    },

    async close({ sessionId }) {
      const stored = await deps.readGraph(sessionId);
      if (!stored) return missingGraph();
      // advance() may have observed a runnable graph before a concurrent stop.
      if (
        stored.phase === "stopped" ||
        stored.phase === "done" ||
        stored.phase === "failed"
      )
        return { ok: true, graph: stored };
      const pending = stored.nodes.filter(
        (node) => node.id !== stored.verifyNodeId && isSuperNodeActive(node.status),
      );
      if (pending.length) {
        return {
          ok: false,
          code: "WORK_PENDING",
          message: `Cannot close the super graph while work is still active: ${pending
            .map((node) => `${node.id} (${node.status})`)
            .join(", ")}.`,
          graph: stored,
        };
      }
      const now = deps.now();
      const graph = closeGraph(stored, {
        now,
        verifyNode: createVerifyNode(deps, stored, now),
      });
      const closed = await commit(graph, stored.rev, "snapshot");
      if (!closed.ok) return closed;
      try {
        const advanced = await raw.advance(sessionId);
        return advanced.graph ? { ok: true, graph: advanced.graph } : closed;
      } catch {
        return closed;
      }
    },

    async stop({ sessionId }) {
      const stored = await deps.readGraph(sessionId);
      if (!stored) return missingGraph();
      const live = stored.nodes
        .filter(
          (node): node is SuperNode & { childSessionId: string } =>
            Boolean(node.childSessionId) &&
            (node.status === "running" || isSuperNodeWaiting(node.status)),
        );
      for (const node of live) {
        try {
          await deps.stopChild(
            node.childSessionId,
            "Super graph stopped by the user.",
          );
        } catch {
          /* A child that already ended needs no stopping. */
        }
      }
      const now = deps.now();
      let graph = stored;
      for (const node of live)
        graph = setNodeStatus(
          graph,
          node.id,
          { status: "failed", error: "Stopped by the user." },
          now,
        );
      graph = markPhase(graph, "stopped", now);
      if (graph === stored) return { ok: true, graph: stored };
      return commit(graph, stored.rev, "snapshot");
    },

    async onChildSettled({
      parentSessionId,
      childSessionId,
      status,
      summary,
    }) {
      // A child can end its run "successfully" while its answer is the tool
      // call it never executed (a provider returning DSML/markup as text).
      // Treat that as a failed attempt: a completed node would hide the gap.
      const artifact =
        status === "completed"
          ? detectToolCallTextArtifact(summary)
          : null;
      const failed = terminalChildStatuses.has(status) || Boolean(artifact);
      const nextStatus = artifact
        ? "failed"
        : status === "completed"
          ? "completed"
          : isSuperNodeWaiting(status) ? status : failed ? "failed" : null;
      if (!nextStatus) return;
      for (let attempt = 0; attempt < MAX_SETTLEMENT_ATTEMPTS; attempt += 1) {
        const stored = await deps.readGraph(parentSessionId);
        if (!stored) return;
        // Recheck on every CAS attempt: another writer may have stopped the
        // graph, settled this node or replaced its child while we were writing.
        if (stored.phase === "stopped" || stored.phase === "done") return;
        const node = stored.nodes.find(
          (entry) => entry.childSessionId === childSessionId,
        );
        if (!node || !isSuperNodeActive(node.status)) return;
        const now = deps.now();
        const failureReason = artifact
          ? `Child answered with a tool-call text artifact (${artifact.marker}); nothing was executed.`
          : failed
            ? `Child session ended as ${status}.`
            : null;
        // A transport fault gets one automatic retry before the graph dies: a
        // dropped stream says nothing about whether the work itself can be done.
        // An artifact or a real failure is not retried — it would just repeat.
        const evidence = `${summary ?? ""}\n${failureReason ?? ""}`.trim();
        const retrying =
          nextStatus === "failed" &&
          !artifact &&
          (node.retries ?? 0) < SUPER_MAX_NODE_RETRIES &&
          isTransientProviderFailure(evidence);
        let graph = retrying
          ? retryNode(stored, {
              nodeId: node.id,
              reason: truncate(evidence, SUPER_MAX_SUMMARY_CHARS),
              now,
            })
          : setNodeStatus(
              stored,
              node.id,
              {
                status: nextStatus,
                summary:
                  !artifact && summary
                    ? truncate(summary, SUPER_MAX_SUMMARY_CHARS)
                    : null,
                error: failureReason,
              },
              now,
            );
        // A graph that already failed never reports done: a late completion
        // must not overwrite the failure that ended it.
        if (
          nextStatus === "completed" &&
          graph.verifyNodeId === node.id &&
          graph.phase !== "failed"
        )
          graph = markPhase(graph, "done", now);
        // One failure ends the graph: its dependents can never run, and a graph
        // left holding queued nodes can neither advance nor close.
        if (!retrying && nextStatus === "failed")
          graph = failGraph(graph, {
            fromNodeId: node.id,
            reason: `Node ${node.id} failed: ${failureReason ?? "no reason recorded"}`,
            now,
          });
        const written = await commit(graph, stored.rev, "nodes");
        if (!written.ok) {
          if (written.code === "REV_CONFLICT" && attempt + 1 < MAX_SETTLEMENT_ATTEMPTS)
            continue;
          // Keep storage failures and exhausted retries visible to the adapter.
          throw new Error(written.message);
        }
        // Waiting does not free a slot or satisfy any prerequisite.
        if (isSuperNodeWaiting(nextStatus)) return;
        // The retry is queued: start it now and keep the parent out of it until
        // the second attempt actually settles.
        if (retrying) {
          let advanced: SuperGraph | null = null;
          try {
            advanced = (await raw.advance(parentSessionId)).graph ?? null;
          } catch {
            /* Advancing must never fail the child's settlement. */
          }
          const latest =
            advanced ?? (await deps.readGraph(parentSessionId).catch(() => null));
          const retried = latest?.nodes.find((entry) => entry.id === node.id);
          // A retry whose child could not even start is a real failure: end the
          // graph instead of leaving a failed node under a running phase.
          if (latest && retried?.status === "failed") {
            const ended = failGraph(latest, {
              fromNodeId: node.id,
              reason: `Node ${node.id} failed: ${retried.error ?? failureReason ?? "the retry could not start"}`,
              now: deps.now(),
            });
            const writtenRetry = await commit(ended, latest.rev, "nodes");
            if (writtenRetry.ok) {
              try {
                await deps.wakeParent?.({
                  parentSessionId,
                  childSessionId,
                  status: "failed",
                  summary: retried.error ?? failureReason ?? null,
                });
              } catch {
                /* Parent wake-up is best effort. */
              }
            }
          }
          return;
        }
        // A failed graph has nothing to advance.
        if (graph.phase !== "failed") {
          // Settlement frees a concurrency slot and may complete a prerequisite.
          try {
            await raw.advance(parentSessionId);
          } catch {
            /* Advancing must never fail the child's settlement. */
          }
        }
        try {
          await deps.wakeParent?.({
            parentSessionId,
            childSessionId,
            status: nextStatus,
            summary: summary ?? null,
          });
        } catch {
          /* Parent wake-up is best effort; the settled graph remains durable. */
        }
        return;
      }
    },

    async advance(sessionId) {
      let failure: SuperCommandResult | null = null;
      for (;;) {
        const stored = await deps.readGraph(sessionId);
        if (!stored) return missingGraph();
        if (
          stored.phase === "stopped" ||
          stored.phase === "done" ||
          stored.phase === "failed"
        )
          return { ok: true, graph: stored };
        if (occupyingNodeCount(stored) >= stored.maxConcurrent)
          return { ok: true, graph: stored };
        // Once close reserved the verification node, delivery is over: only
        // that node may start, never a work node left queued by the plan.
        const next = stored.verifyNodeId
          ? stored.nodes.find(
              (node) =>
                node.id === stored.verifyNodeId && node.status === "queued",
            )
          : stored.nodes.find(
              (node) =>
                node.status === "queued" &&
                dependenciesOf(stored, node.id).every(
                  (id) => graphNode(stored, id)?.status === "completed",
                ),
            );
        if (!next) {
          return failure ? { ...failure, graph: stored } : { ok: true, graph: stored };
        }
        const started = await raw.start({ sessionId, nodeId: next.id });
        if (!started.ok) {
          // A failure without a persisted graph leaves the node queued; trying
          // again would spin, so surface it. Otherwise keep starting the
          // remaining runnable nodes and report the failure at the end.
          if (!started.graph) return started;
          failure = failure ?? started;
        }
      }
    },
  };

  // Serialize this instance's use cases per session. CAS still protects writes
  // against other service instances, and settlement rechecks on conflict.
  const serialize = createSessionQueue();
  return {
    getGraph: (sessionId) => serialize(sessionId, () => raw.getGraph(sessionId)),
    plan: (input) => serialize(input.sessionId, () => raw.plan(input)),
    start: (input) => serialize(input.sessionId, () => raw.start(input)),
    advance: (sessionId) => serialize(sessionId, () => raw.advance(sessionId)),
    message: (input) => serialize(input.sessionId, () => raw.message(input)),
    close: (input) => serialize(input.sessionId, () => raw.close(input)),
    stop: (input) => serialize(input.sessionId, () => raw.stop(input)),
    onChildSettled: (input) =>
      serialize(input.parentSessionId, () => raw.onChildSettled(input)),
  };
}
