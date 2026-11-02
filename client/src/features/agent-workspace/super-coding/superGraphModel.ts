import type {
  SuperGraph,
  SuperNode,
  SuperNodeStatus,
  SuperPhase,
} from "../../../../../packages/contracts/super-coding";

export const NODE_WIDTH = 172;
export const NODE_HEIGHT = 64;
const COLUMN_GAP = 64;
const ROW_GAP = 22;
const PADDING = 16;

export const PHASE_LABEL: Record<SuperPhase, string> = {
  planning: "规划中",
  running: "执行中",
  done: "已交付",
  stopped: "已停止",
  failed: "已失败",
};

export const NODE_STATUS_LABEL: Record<SuperNodeStatus, string> = {
  queued: "排队",
  running: "运行",
  waiting_input: "等待输入",
  waiting_permission: "等待授权",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  archived: "已归档",
};

export interface PlacedNode {
  node: SuperNode;
  x: number;
  y: number;
}

export interface GraphLayout {
  placed: PlacedNode[];
  width: number;
  height: number;
}

function byDepth(nodes: SuperNode[]): Map<number, SuperNode[]> {
  const columns = new Map<number, SuperNode[]>();
  for (const node of nodes) {
    const column = columns.get(node.depth) ?? [];
    column.push(node);
    columns.set(node.depth, column);
  }
  return columns;
}

/**
 * Deterministic layered layout: depth chooses the column, creation order (then
 * id) chooses the row, so re-rendering the same graph never moves a node.
 */
export function layoutGraph(graph: SuperGraph): GraphLayout {
  const columns = byDepth(graph.nodes);
  const depths = [...columns.keys()].sort((a, b) => a - b);
  const placed: PlacedNode[] = [];
  let widest = 1;

  depths.forEach((depth, columnIndex) => {
    const nodes = [...(columns.get(depth) ?? [])].sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    widest = Math.max(widest, nodes.length);
    nodes.forEach((node, row) => {
      placed.push({
        node,
        x: PADDING + columnIndex * (NODE_WIDTH + COLUMN_GAP),
        y: PADDING + row * (NODE_HEIGHT + ROW_GAP),
      });
    });
  });

  return {
    placed,
    width: Math.max(
      NODE_WIDTH + PADDING * 2,
      PADDING * 2 + depths.length * (NODE_WIDTH + COLUMN_GAP) - COLUMN_GAP,
    ),
    height: Math.max(
      NODE_HEIGHT + PADDING * 2,
      PADDING * 2 + widest * (NODE_HEIGHT + ROW_GAP) - ROW_GAP,
    ),
  };
}

/** Cubic edge between the right edge of one node and the left edge of another. */
export function edgePath(from: PlacedNode, to: PlacedNode): string {
  const x1 = from.x + NODE_WIDTH;
  const y1 = from.y + NODE_HEIGHT / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_HEIGHT / 2;
  if (to.x <= from.x) {
    const ax = from.x + NODE_WIDTH / 2;
    const bx = to.x + NODE_WIDTH / 2;
    return `M${ax} ${from.y + NODE_HEIGHT} C${ax} ${from.y + NODE_HEIGHT + 32}, ${bx} ${to.y + NODE_HEIGHT + 32}, ${bx} ${to.y + NODE_HEIGHT}`;
  }
  const mid = (x1 + x2) / 2;
  return `M${x1} ${y1} C${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
}

export interface GraphCounts {
  live: number;
  failed: number;
  archived: number;
  running: number;
  waiting: number;
  messages: number;
  maxNodes: number;
}

export function graphCounts(graph: SuperGraph | null): GraphCounts {
  if (!graph)
    return {
      live: 0,
      failed: 0,
      archived: 0,
      running: 0,
      waiting: 0,
      messages: 0,
      maxNodes: 0,
    };
  let live = 0;
  let failed = 0;
  let archived = 0;
  let running = 0;
  let waiting = 0;
  let messages = 0;
  for (const node of graph.nodes) {
    messages += node.messages;
    if (node.status === "archived") {
      archived += 1;
      continue;
    }
    // Mirrors `budgetedNodes` in the contracts: a failed node keeps its record
    // but its slot is free again, so the card must not count it as live.
    if (node.status === "failed") {
      failed += 1;
      continue;
    }
    live += 1;
    if (node.status === "running") running += 1;
    if (node.status === "waiting_input" || node.status === "waiting_permission")
      waiting += 1;
  }
  return {
    live,
    failed,
    archived,
    running,
    waiting,
    messages,
    maxNodes: graph.maxNodes,
  };
}

export function nodeAriaLabel(node: SuperNode): string {
  const parts = [
    node.title,
    NODE_STATUS_LABEL[node.status],
    node.taskType,
    node.model,
  ].filter(Boolean);
  return parts.join("，");
}

export function budgetText(graph: SuperGraph | null): string {
  const counts = graphCounts(graph);
  return `节点 ${counts.live}/${counts.maxNodes}`;
}

/** The close action stays disabled until something can actually be archived. */
export function canCloseGraph(graph: SuperGraph | null): boolean {
  if (!graph) return false;
  // A failed graph is terminal too: closing it would archive an unfinished run.
  if (
    graph.phase === "done" ||
    graph.phase === "stopped" ||
    graph.phase === "failed"
  )
    return false;
  return graph.nodes.some(
    (node) => node.status === "completed" || node.status === "failed",
  );
}
