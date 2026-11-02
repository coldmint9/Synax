/**
 * Super coding mode: bounded subagent DAG orchestration.
 *
 * Shared by the local runtime (planning, admission, close) and the client
 * (graph card, settings). Keep this file free of runtime imports so both sides
 * can depend on it without pulling in infrastructure.
 */

export const SUPER_MODE = "super" as const;

/** maxNodes includes exactly one reserved slot for the verify node. */
export const SUPER_DEFAULT_MAX_NODES = 8;
export const SUPER_MIN_MAX_NODES = 4;
export const SUPER_MAX_MAX_NODES = 12;
export const SUPER_MAX_CONCURRENT = 5;

export const SUPER_MAX_MESSAGES_PER_NODE = 6;
export const SUPER_MAX_MESSAGE_CHARS = 1500;
export const SUPER_MAX_BRIEF_CHARS = 4000;

export const SUPER_TASK_TYPES = [
  "explore",
  "design",
  "implement",
  "review",
  "verify",
  "docs",
] as const;
export type SuperTaskType = (typeof SUPER_TASK_TYPES)[number];

export const SUPER_MODEL_TAGS = [
  "deep-reasoning",
  "fast-edit",
  "long-context",
  "tool-use",
  "cheap",
  "vision",
] as const;
export type SuperModelTag = (typeof SUPER_MODEL_TAGS)[number];

/**
 * `failed` is terminal like `stopped`, but it records that the graph died of a
 * node failure instead of a user request: no queued node survives it, so a
 * failed graph can never sit half-open waiting on a dependency that will never
 * complete.
 */
export type SuperPhase =
  | "planning"
  | "running"
  | "done"
  | "stopped"
  | "failed";

export type SuperNodeStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "waiting_permission"
  | "paused"
  | "completed"
  | "failed"
  | "archived";

export type SuperEdgeKind = "dependency" | "message";

export interface SuperNodeMessage {
  from: "main" | "user" | "child";
  text: string;
  at: string;
  delivery: "delivered" | "queued";
}

export interface SuperNode {
  id: string;
  title: string;
  taskType: SuperTaskType;
  objective: string;
  deliverable: string;
  acceptance: string[];
  /** Empty inherits the parent's write access; invalid nonempty scopes fail start. */
  scope: string[];
  status: SuperNodeStatus;
  depth: number;
  /** provider/model chosen by routing; shown in the node's routing tab. */
  model: string;
  effort: "high" | "xhigh" | "max";
  childSessionId: string | null;
  /** Number of delivered messages, capped by SUPER_MAX_MESSAGES_PER_NODE. */
  messages: number;
  /** Automatic retries already spent on transient failures. */
  retries?: number;
  /** Why the last attempt ended; kept while the node retries or is revived. */
  lastError?: string | null;
  /** Bounded channel log; older graphs and nodes omit it. */
  messageLog?: SuperNodeMessage[];
  summary: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SuperEdge {
  id: string;
  from: string;
  to: string;
  kind: SuperEdgeKind;
  count: number;
}

export interface SuperGraph {
  id: string;
  sessionId: string;
  /** Monotonic per graph; the only ordering key the client trusts. */
  rev: number;
  phase: SuperPhase;
  /** Why the whole graph failed; absent or null while it has not failed. */
  phaseError?: string | null;
  maxNodes: number;
  maxConcurrent: number;
  nodes: SuperNode[];
  edges: SuperEdge[];
  /** Set once close() created the verify node, so close stays idempotent. */
  verifyNodeId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SuperModelOption {
  id: string;
  label: string;
  enabled: boolean;
  tags: SuperModelTag[];
  /** Optional reasoning override for this model; omitted means inherit. */
  effort?: "high" | "xhigh" | "max";
}

export interface SuperModelRoute {
  taskTypes: SuperTaskType[];
  model: string;
}

export interface SuperCodingConfig {
  models: SuperModelOption[];
  /** Ordered: the first matching route wins. */
  routes: SuperModelRoute[];
  defaultModel: string;
  maxNodes: number;
  maxConcurrent: number;
}

/** Why a node got this model; `inherit` is the unconfigured pool. */
export type SuperModelSource = "route" | "default" | "inherit";

export interface SuperModelDecision {
  /** Empty means the child inherits the parent session's selected model. */
  model: string;
  source: SuperModelSource;
}

export type SuperCommand =
  | { kind: "node.message"; nodeId: string; text: string }
  | { kind: "graph.close" }
  | { kind: "graph.stop" };

export interface SuperCommandResult {
  ok: boolean;
  code?: string;
  message?: string;
  graph?: SuperGraph;
}

export interface SuperSnapshotResponse {
  graph: SuperGraph | null;
}

export interface SuperChannelResponse {
  items: SuperNodeMessage[];
}

export const SUPER_EVENT_TYPES = ["super.snapshot", "super.nodes", "super.msg"] as const;
export type SuperEventType = (typeof SUPER_EVENT_TYPES)[number];

export const SUPER_DEFAULT_CONFIG: SuperCodingConfig = {
  models: [],
  routes: [],
  defaultModel: "",
  maxNodes: SUPER_DEFAULT_MAX_NODES,
  maxConcurrent: SUPER_MAX_CONCURRENT,
};

export function isSuperNodeActive(status: SuperNodeStatus): boolean {
  return status !== "completed" && status !== "failed" && status !== "archived";
}

/** Waiting children remain live and keep their graph concurrency slot. */
export function isSuperNodeWaiting(
  status: string,
): status is "waiting_input" | "waiting_permission" | "paused" {
  return (
    status === "waiting_input" ||
    status === "waiting_permission" ||
    status === "paused"
  );
}

/**
 * Deterministic model routing for one node.
 *
 * Only the configured pool may name a model: the first matching route, then the
 * pool default. An empty pool is a valid state, not an error — the child then
 * inherits the parent session's selected model, so super mode never silently
 * moves the user's work onto a different provider or model.
 */
export function resolveSuperModel(
  config: Pick<SuperCodingConfig, "routes" | "defaultModel">,
  taskType: SuperTaskType,
): SuperModelDecision {
  const route = config.routes.find((entry) =>
    entry.taskTypes.includes(taskType),
  );
  if (route?.model) return { model: route.model, source: "route" };
  if (config.defaultModel)
    return { model: config.defaultModel, source: "default" };
  return { model: "", source: "inherit" };
}

/**
 * Nodes that occupy a graph slot: the single rule every budget consumer uses.
 *
 * Archived and failed nodes never occupy a slot. Archiving is explicit data
 * retention; a failure is terminal on its own, so the slot comes back the
 * moment the child settles instead of waiting for `close()`. The record stays
 * (error, messages, child id) for audit and for the graph card.
 */
export function budgetedNodes(graph: Pick<SuperGraph, "nodes">): SuperNode[] {
  return graph.nodes.filter(
    (node) => node.status !== "archived" && node.status !== "failed",
  );
}

export function liveNodeCount(graph: Pick<SuperGraph, "nodes">): number {
  return budgetedNodes(graph).length;
}

/** One slot is reserved for the verify node so close() can never be blocked. */
export function admitLimit(graph: Pick<SuperGraph, "maxNodes">): number {
  return Math.max(0, graph.maxNodes - 1);
}

export function hasCapacityForNode(graph: Pick<SuperGraph, "nodes" | "maxNodes">): boolean {
  return liveNodeCount(graph) < admitLimit(graph);
}

export function availableSlots(graph: Pick<SuperGraph, "nodes" | "maxNodes">): number {
  return Math.max(0, admitLimit(graph) - liveNodeCount(graph));
}

export function createEmptySuperGraph(input: {
  sessionId: string;
  now: string;
  maxNodes?: number;
  maxConcurrent?: number;
}): SuperGraph {
  const maxNodes = input.maxNodes ?? SUPER_DEFAULT_MAX_NODES;
  return {
    id: `super:${input.sessionId}`,
    sessionId: input.sessionId,
    rev: 0,
    phase: "planning",
    maxNodes,
    maxConcurrent: Math.min(input.maxConcurrent ?? SUPER_MAX_CONCURRENT, SUPER_MAX_CONCURRENT, maxNodes),
    nodes: [],
    edges: [],
    verifyNodeId: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}
