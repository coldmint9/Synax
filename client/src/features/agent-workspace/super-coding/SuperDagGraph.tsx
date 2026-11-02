import type { SuperGraph, SuperNode } from "../../../../../packages/contracts/super-coding";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  NODE_STATUS_LABEL,
  edgePath,
  layoutGraph,
  nodeAriaLabel,
} from "./superGraphModel";

interface Props {
  graph: SuperGraph;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}

const STATUS_CLASS: Record<SuperNode["status"], string> = {
  queued: "border-border bg-card text-muted-foreground",
  running: "border-emerald-500 bg-emerald-50/70",
  waiting_input: "border-amber-400 bg-amber-50",
  waiting_permission: "border-amber-400 bg-amber-50",
  paused: "border-dashed border-border bg-card",
  completed: "border-emerald-600/40 bg-card",
  failed: "border-rose-300 bg-rose-50",
  archived: "border-dashed border-border bg-muted/40 opacity-60",
};

export function SuperDagGraph({
  graph,
  selectedNodeId,
  onSelectNode,
}: Props) {
  const { placed, width, height } = layoutGraph(graph);
  const positions = new Map(placed.map((item) => [item.node.id, item]));

  return (
    <div
      className="relative overflow-auto"
      role="img"
      aria-label={`编排图，共 ${placed.length} 个节点，${graph.edges.length} 条边`}
    >
      <div style={{ width, height, position: "relative" }}>
        <svg
          aria-hidden="true"
          width={width}
          height={height}
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          {graph.edges.map((edge) => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            if (!from || !to) return null;
            return (
              <path
                key={edge.id}
                d={edgePath(from, to)}
                fill="none"
                stroke={edge.kind === "message" ? "#7fa08c" : "#c3c9c2"}
                strokeWidth={edge.kind === "message" ? 1.3 : 1.1}
                strokeDasharray={edge.kind === "message" ? "4 3" : undefined}
              />
            );
          })}
        </svg>
        {placed.map(({ node, x, y }) => (
          <button
            key={node.id}
            type="button"
            onClick={() => onSelectNode(node.id)}
            aria-label={nodeAriaLabel(node)}
            aria-pressed={selectedNodeId === node.id}
            className={`absolute flex flex-col gap-1 overflow-hidden rounded-lg border px-2 py-1.5 text-left ${STATUS_CLASS[node.status]} ${selectedNodeId === node.id ? "ring-2 ring-emerald-600/40" : ""}`}
            style={{ left: x, top: y, width: NODE_WIDTH, height: NODE_HEIGHT }}
          >
            <span className="truncate text-[11.5px] font-semibold">{node.title}</span>
            <span className="flex items-center gap-1.5 truncate text-[10px] text-muted-foreground">
              <span>{NODE_STATUS_LABEL[node.status]}</span>
              <span>· {node.taskType}</span>
              {node.messages > 0 && <span>· {node.messages}</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
