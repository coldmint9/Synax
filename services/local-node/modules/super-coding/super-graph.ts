/**
 * Super coding graph rules.
 *
 * Pure functions only: no store, IO, clock or framework imports. Every mutator
 * returns a new graph (never mutates the input) and bumps `rev`, because `rev`
 * is the only ordering key the client trusts.
 *
 * Dependency edges point from the prerequisite to its dependent, so a node's
 * prerequisites are the dependency edges whose `to` is that node.
 */
import {
  SUPER_MAX_MESSAGES_PER_NODE,
  admitLimit,
  isSuperNodeActive,
  isSuperNodeWaiting,
  liveNodeCount,
  type SuperEdge,
  type SuperGraph,
  type SuperNode,
  type SuperNodeMessage,
  type SuperNodeStatus,
  type SuperPhase,
} from "../../../../packages/contracts/super-coding.js";

/** Id of the single reserved verification node, reused by every close(). */
export const SUPER_VERIFY_NODE_ID = "verify";

export type SuperAdmitCode = "DUP_ID" | "NO_PARENT" | "CYCLE" | "BUDGET";

export interface SuperAdmitRejection {
  ok: false;
  code: SuperAdmitCode;
  /** One executable next step; the caller must not replan the whole graph. */
  action: string;
  message: string;
}

export type SuperAdmitResult = { ok: true } | SuperAdmitRejection;

export interface SuperNodeStatusPatch {
  status: SuperNodeStatus;
  childSessionId?: string | null;
  summary?: string | null;
  error?: string | null;
  model?: string;
  effort?: SuperNode["effort"];
}

export function isFinishedNode(status: SuperNodeStatus): boolean {
  return status === "completed" || status === "failed";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function nextGraph(
  graph: SuperGraph,
  patch: Partial<SuperGraph>,
  now: string,
): SuperGraph {
  return { ...graph, ...patch, rev: graph.rev + 1, updatedAt: now };
}

export function graphNode(
  graph: Pick<SuperGraph, "nodes">,
  nodeId: string,
): SuperNode | undefined {
  return graph.nodes.find((node) => node.id === nodeId);
}

/** Prerequisite ids of a node, in edge order. */
export function dependenciesOf(
  graph: Pick<SuperGraph, "edges">,
  nodeId: string,
): string[] {
  return unique(
    graph.edges
      .filter((edge) => edge.kind === "dependency" && edge.to === nodeId)
      .map((edge) => edge.from),
  );
}

/** Nodes that depend on `nodeId`, in edge order. */
export function dependentsOf(
  graph: Pick<SuperGraph, "edges">,
  nodeId: string,
): string[] {
  return unique(
    graph.edges
      .filter((edge) => edge.kind === "dependency" && edge.from === nodeId)
      .map((edge) => edge.to),
  );
}

/**
 * Terminates the whole graph because one node failed.
 *
 * A queued node whose upstream failed can never run, so leaving it queued would
 * keep `close()` blocked forever and hide the failure behind a silent stall.
 * The failure therefore cascades along dependency edges: every transitively
 * dependent node that has not started is failed with the upstream as its
 * reason. Running children keep their own status — their settlement is ignored
 * once the graph is terminal.
 */
export function failGraph(
  graph: SuperGraph,
  input: { fromNodeId: string; reason: string; now: string },
): SuperGraph {
  const tainted = new Set<string>([input.fromNodeId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const edge of graph.edges) {
      if (edge.kind !== "dependency" || !tainted.has(edge.from)) continue;
      if (tainted.has(edge.to)) continue;
      tainted.add(edge.to);
      grew = true;
    }
  }
  const nodes = graph.nodes.map((node) => {
    if (node.id === input.fromNodeId) return node;
    if (!tainted.has(node.id) || node.status !== "queued") return node;
    return {
      ...node,
      status: "failed" as const,
      error: `Upstream node ${input.fromNodeId} failed.`,
      updatedAt: input.now,
    };
  });
  return nextGraph(
    graph,
    { nodes, phase: "failed", phaseError: input.reason },
    input.now,
  );
}

/** Nodes whose child session is alive, i.e. the concurrency budget in use. */
export function occupyingNodeCount(graph: Pick<SuperGraph, "nodes">): number {
  return graph.nodes.filter(
    (node) => node.status === "running" || isSuperNodeWaiting(node.status),
  ).length;
}

/**
 * A cycle appears when the new dependency edges (requires -> nodeId) close a
 * path that already leads from nodeId back to a requirement.
 */
export function createsCycle(
  graph: Pick<SuperGraph, "edges">,
  nodeId: string,
  requires: readonly string[],
): boolean {
  if (requires.includes(nodeId)) return true;
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "dependency") continue;
    const dependents = adjacency.get(edge.from) ?? [];
    dependents.push(edge.to);
    adjacency.set(edge.from, dependents);
  }
  const reachable = new Set<string>();
  const stack = [...(adjacency.get(nodeId) ?? [])];
  while (stack.length) {
    const id = stack.pop() as string;
    if (reachable.has(id)) continue;
    reachable.add(id);
    stack.push(...(adjacency.get(id) ?? []));
  }
  return requires.some((id) => reachable.has(id));
}

/**
 * Admission is the single gate: duplicate id, missing parent, cycle, budget.
 * `maxNodes - 1` keeps the verification slot free, so close() can never be
 * blocked by the graph's own limit.
 */
export function admitNode(
  graph: Pick<SuperGraph, "nodes" | "edges" | "maxNodes">,
  node: Pick<SuperNode, "id" | "depth">,
  requires: readonly string[],
): SuperAdmitResult {
  if (graph.nodes.some((existing) => existing.id === node.id))
    return {
      ok: false,
      code: "DUP_ID",
      message: `Node ${node.id} already exists in this graph.`,
      action: `Inspect node ${node.id} instead of planning a second node with that id.`,
    };
  const parentId = requires[0];
  const known = (id: string) => graph.nodes.some((existing) => existing.id === id);
  const dangling = requires.filter((id) => id !== node.id && !known(id));
  if (
    (node.depth > 0 && !(parentId && known(parentId))) ||
    dangling.length > 0
  )
    return {
      ok: false,
      code: "NO_PARENT",
      message: `Node ${node.id} needs a parent node that is already in the graph${(dangling[0] ?? parentId) ? ` (missing ${dangling[0] ?? parentId})` : ""}.`,
      action: `Plan the parent node first, then list its id in requires.`,
    };
  if (createsCycle(graph, node.id, requires))
    return {
      ok: false,
      code: "CYCLE",
      message: `Node ${node.id} would depend on itself through ${requires.join(", ")}.`,
      action: `Remove the back-edge; requires may only point at upstream nodes.`,
    };
  const used = liveNodeCount(graph);
  const limit = admitLimit(graph);
  if (used >= limit)
    return {
      ok: false,
      code: "BUDGET",
      message: `Node budget is full: ${used}/${limit} slots in use (failed and archived nodes already released theirs; one slot stays reserved for verification).`,
      action: `Call super.close to archive the completed nodes, then plan again.`,
    };
  return { ok: true };
}

/**
 * Archive a finished node. Queued, running or already archived nodes are left
 * untouched, so a mistaken id can never delete live work.
 */
export function archiveNode(
  graph: SuperGraph,
  nodeId: string,
  now: string,
): SuperGraph {
  const node = graphNode(graph, nodeId);
  if (!node || !isFinishedNode(node.status)) return graph;
  return nextGraph(
    graph,
    {
      nodes: graph.nodes.map((entry) =>
        entry.id === nodeId
          ? { ...entry, status: "archived" as const, updatedAt: now }
          : entry,
      ),
    },
    now,
  );
}

/**
 * Close archives every finished node, then reuses or creates the single
 * verification node. Idempotent: the verify node keeps one id and is never
 * duplicated; the graph becomes `done` once that node completed.
 */
export function closeGraph(
  graph: SuperGraph,
  input: { now: string; verifyNode: SuperNode },
): SuperGraph {
  const verifyNodeId = graph.verifyNodeId ?? input.verifyNode.id;
  const existing = graphNode(graph, verifyNodeId);
  const nodes = graph.nodes.map((node) => {
    if (node.id === verifyNodeId) return node;
    return isFinishedNode(node.status)
      ? { ...node, status: "archived" as const, updatedAt: input.now }
      : node;
  });
  if (!existing)
    nodes.push({ ...input.verifyNode, id: verifyNodeId, updatedAt: input.now });
  const verifyStatus = existing?.status ?? input.verifyNode.status;
  const phase: SuperPhase = verifyStatus === "completed" ? "done" : "running";
  return nextGraph(
    graph,
    { nodes, phase, verifyNodeId },
    input.now,
  );
}

export function upsertNode(
  graph: SuperGraph,
  node: SuperNode,
  now: string,
): SuperGraph {
  const stamped = { ...node, updatedAt: now };
  const exists = graph.nodes.some((entry) => entry.id === node.id);
  return nextGraph(
    graph,
    {
      nodes: exists
        ? graph.nodes.map((entry) =>
            entry.id === node.id ? stamped : entry,
          )
        : [...graph.nodes, stamped],
    },
    now,
  );
}

export function upsertEdge(
  graph: SuperGraph,
  edge: SuperEdge,
  now: string,
): SuperGraph {
  const exists = graph.edges.some((entry) => entry.id === edge.id);
  return nextGraph(
    graph,
    {
      edges: exists
        ? graph.edges.map((entry) => (entry.id === edge.id ? edge : entry))
        : [...graph.edges, edge],
    },
    now,
  );
}

export function setNodeStatus(
  graph: SuperGraph,
  nodeId: string,
  patch: SuperNodeStatusPatch,
  now: string,
): SuperGraph {
  const target = graphNode(graph, nodeId);
  // Settled results are immutable. Only explicit archive/close may move them
  // into retention; a late callback must not revive or replace the result.
  if (!target || !isSuperNodeActive(target.status)) return graph;
  return nextGraph(
    graph,
    {
      nodes: graph.nodes.map((node) =>
        node.id === nodeId ? { ...node, ...patch, updatedAt: now } : node,
      ),
    },
    now,
  );
}

/** Record one delivered message against a node; the cap is enforced upstream. */
export function appendNodeMessage(
  graph: SuperGraph,
  nodeId: string,
  message: SuperNodeMessage,
  now = new Date().toISOString(),
): SuperGraph {
  const node = graphNode(graph, nodeId);
  if (!node) return graph;
  const log = [...(node.messageLog ?? []), message].slice(
    -SUPER_MAX_MESSAGES_PER_NODE,
  );
  return {
    ...graph,
    rev: graph.rev + 1,
    updatedAt: now,
    nodes: graph.nodes.map((item) =>
      item.id === nodeId
        ? {
            ...item,
            messages: item.messages + 1,
            messageLog: log,
            updatedAt: now,
          }
        : item,
    ),
  };
}

export function addMessageCount(
  graph: SuperGraph,
  nodeId: string,
  now: string,
): SuperGraph {
  if (!graphNode(graph, nodeId)) return graph;
  return nextGraph(
    graph,
    {
      nodes: graph.nodes.map((node) =>
        node.id === nodeId
          ? { ...node, messages: node.messages + 1, updatedAt: now }
          : node,
      ),
    },
    now,
  );
}

export function markPhase(
  graph: SuperGraph,
  phase: SuperPhase,
  now: string,
): SuperGraph {
  if (graph.phase === phase) return graph;
  return nextGraph(graph, { phase }, now);
}

/**
 * Reopens a failed graph for an explicit new plan.
 *
 * The failure already cascaded, so nothing is left queued behind it; clearing
 * the marker is what lets the orchestrator admit replacement work in the same
 * session instead of abandoning it.
 */
export function clearGraphFailure(
  graph: SuperGraph,
  now: string,
): SuperGraph {
  if (graph.phase !== "failed" && !graph.phaseError) return graph;
  return nextGraph(graph, { phase: "running", phaseError: null }, now);
}

/** The exact reason `failGraph` writes on every cascaded dependent. */
export function cascadeReason(fromNodeId: string): string {
  return `Upstream node ${fromNodeId} failed.`;
}

/**
 * Puts a failed node back into the queue with a fresh attempt, keeping its id,
 * depth, dependency edges and message log. Its own error becomes `lastError` so
 * the reason stays auditable while the new attempt runs.
 */
export function requeueFailedNode(
  graph: SuperGraph,
  input: { nodeId: string; spec?: Partial<SuperNode>; now: string },
): SuperGraph {
  const nodes = graph.nodes.map((node) => {
    if (node.id !== input.nodeId || node.status !== "failed") return node;
    return {
      ...node,
      ...(input.spec ?? {}),
      status: "queued" as const,
      childSessionId: null,
      summary: null,
      error: null,
      lastError: node.error ?? node.lastError ?? null,
      messages: 0,
      updatedAt: input.now,
    };
  });
  return nextGraph(graph, { nodes }, input.now);
}

/**
 * Revives a failed node in place and returns the dependents that the same
 * failure cascaded, so one plan call can resume the chain instead of rebuilding
 * it with new ids.
 */
export function reviveFailedNode(
  graph: SuperGraph,
  input: { nodeId: string; spec?: Partial<SuperNode>; now: string },
): SuperGraph {
  const revived = requeueFailedNode(graph, input);
  const cascaded = cascadeReason(input.nodeId);
  const nodes = revived.nodes.map((node) =>
    node.status === "failed" && node.error === cascaded
      ? {
          ...node,
          status: "queued" as const,
          error: null,
          lastError: node.error,
          updatedAt: input.now,
        }
      : node,
  );
  return nextGraph({ ...revived, nodes }, {}, input.now);
}

/**
 * Requeues a node for its automatic retry: the transient failure is recorded
 * but nothing cascades, because the attempt is expected to run again.
 */
export function retryNode(
  graph: SuperGraph,
  input: { nodeId: string; reason: string; now: string },
): SuperGraph {
  const nodes = graph.nodes.map((node) => {
    if (node.id !== input.nodeId) return node;
    return {
      ...node,
      status: "queued" as const,
      childSessionId: null,
      summary: null,
      error: null,
      lastError: input.reason,
      retries: (node.retries ?? 0) + 1,
      updatedAt: input.now,
    };
  });
  return nextGraph(graph, { nodes }, input.now);
}
