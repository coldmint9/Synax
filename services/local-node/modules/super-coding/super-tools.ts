import * as z from "zod/v4";
import {
  SUPER_MAX_MAX_NODES,
  SUPER_TASK_TYPES,
  type SuperCommandResult,
  type SuperGraph,
} from "../../../../packages/contracts/super-coding.js";
import type {
  RegisteredTool,
  ToolExecutionResult,
} from "../agent-runtime/contracts.js";
import type { SuperService } from "./super-service.js";

/** Raw input is truncated by the service; the schema only bounds abuse. */
const maxRawMessageChars = 20_000;

export const superPlanNodeSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe("Stable node id, unique inside the graph."),
  title: z.string().trim().min(1).max(200).describe("Short node label."),
  taskType: z
    .enum(SUPER_TASK_TYPES)
    .describe("Task type; it selects the routed model from the model pool."),
  objective: z
    .string()
    .trim()
    .min(1)
    .max(4_000)
    .describe("What this node must achieve, in one or two sentences."),
  deliverable: z
    .string()
    .trim()
    .min(1)
    .max(4_000)
    .describe("Concrete output the child must return."),
  acceptance: z
    .array(z.string().trim().min(1).max(1_000))
    .max(20)
    .optional()
    .describe("Checkable acceptance criteria copied into the child brief."),
  scope: z
    .array(z.string().trim().min(1).max(1_024))
    .max(20)
    .optional()
    .describe(
      "Workspace-relative write scope; empty inherits the parent's access.",
    ),
  requires: z
    .array(z.string().trim().min(1).max(64))
    .max(SUPER_MAX_MAX_NODES)
    .optional()
    .describe("Ids of upstream nodes this node depends on."),
});

export const superPlanArgsSchema = z.object({
  nodes: z
    .array(superPlanNodeSchema)
    .min(1)
    .max(SUPER_MAX_MAX_NODES)
    .describe(
      "Nodes to admit in order; a rejected node is never written and the accepted prefix stays.",
    ),
});

export const superMessageArgsSchema = z.object({
  nodeId: z.string().trim().min(1).max(64).describe("Target node id."),
  text: z
    .string()
    .trim()
    .min(1)
    .max(maxRawMessageChars)
    .describe(
      "Instruction for the node's child session; delivered at its next turn boundary.",
    ),
});

export const superCloseArgsSchema = z.object({});

export type SuperPlanArgs = z.infer<typeof superPlanArgsSchema>;
export type SuperMessageArgs = z.infer<typeof superMessageArgsSchema>;

export const superToolIds = [
  "super.plan",
  "super.message",
  "super.close",
] as const;

function toolResult(
  result: SuperCommandResult,
  okSummary: string,
): ToolExecutionResult {
  return {
    result,
    displaySummary: result.ok
      ? okSummary
      : `${result.code ?? "REJECTED"}: ${result.message ?? ""}`.trim(),
    outcome: result.ok ? undefined : "failed",
    artifacts: [],
  };
}

/** Nodes this call moved into `running`; used only for the summary text. */
function runningNodeDelta(
  before: SuperGraph | undefined,
  after: SuperGraph | undefined,
): number {
  if (!after) return 0;
  const previous = new Map(
    (before?.nodes ?? []).map((node) => [node.id, node.status]),
  );
  return after.nodes.filter(
    (node) => node.status === "running" && previous.get(node.id) !== "running",
  ).length;
}

export function createSuperTools(service: SuperService): RegisteredTool[] {
  return [
    {
      id: "super.plan",
      label: "Plan Super Nodes",
      description:
        "Admit bounded subagent nodes into the session's super graph. Runnable nodes start immediately, so planning is also the start signal. Duplicate ids, missing parents, cycles and a full budget are refused with exactly one next action, and a refused node is never written. The graph holds at most maxNodes nodes, one of which is reserved for the final verification node; a failed or archived node keeps its record but frees its slot.",
      progressiveDetails:
        "Each node becomes one subagent session. List upstream ids in requires; a node may only start after those nodes completed, and it starts by itself at that moment. Do not ask the user to start nodes. Use super.message for bounded instructions and super.close to archive finished nodes; close starts the single verification node automatically. A failed node leaves the budget on its own, so plan a replacement node for work that still has to happen instead of waiting on it. Nodes are never merged, deduplicated or split automatically.",
      category: "task",
      internalGate: "task",
      mutability: "task",
      resumeBehavior: "auto",
      inputSchema: superPlanArgsSchema,
      async execute(input) {
        const args = superPlanArgsSchema.parse(input.args);
        const planned = await service.plan({
          sessionId: input.sessionId,
          nodes: args.nodes,
        });
        if (!planned.ok) return toolResult(planned, "");
        // The graph is saved at this point; a failed start must be reported
        // without making the model plan the same nodes again.
        const advanced = await service.advance(input.sessionId);
        const graph = advanced.graph ?? planned.graph;
        return {
          result: { ok: true, graph },
          displaySummary: advanced.ok
            ? `Planned ${args.nodes.length} super node(s); ${runningNodeDelta(planned.graph, graph)} running.`
            : `Planned ${args.nodes.length} super node(s), but some could not start: ${advanced.code ?? "ERROR"} ${advanced.message ?? ""} The graph is saved; do not replan it.`.trim(),
          artifacts: [],
        };
      },
    },
    {
      id: "super.message",
      label: "Message Super Node",
      description:
        "Send one bounded instruction to a running super node's child session. It takes effect at the child's next turn boundary, never mid-step. Each node accepts a limited number of messages, and archived nodes are read-only.",
      progressiveDetails:
        "Use nodeId from super.plan output or the graph snapshot. A node must have a child session already. Messages do not wake finished nodes and are not broadcast; message the specific node that needs the instruction.",
      category: "task",
      internalGate: "task",
      mutability: "task",
      resumeBehavior: "auto",
      inputSchema: superMessageArgsSchema,
      async execute(input) {
        const args = superMessageArgsSchema.parse(input.args);
        return toolResult(
          await service.message({
            sessionId: input.sessionId,
            nodeId: args.nodeId,
            from: "main",
            text: args.text,
          }),
          `Sent a message to ${args.nodeId}.`,
        );
      },
    },
    {
      id: "super.close",
      label: "Close Super Graph",
      description:
        "When every required work node has actually settled, archive the finished nodes, then reuse or create the single verification node and start it. Refuse close while any work node is queued, running or waiting. Idempotent: repeated calls keep one verification node, and the graph becomes done once that node completed. The verification slot is reserved, so close is never blocked by the node budget.",
      progressiveDetails:
        "Call close when the deliverable is ready. Archived nodes keep their data for audit and stop consuming budget; the verification node has no prerequisites, so it can start immediately.",
      category: "task",
      internalGate: "task",
      mutability: "task",
      resumeBehavior: "auto",
      inputSchema: superCloseArgsSchema,
      async execute(input) {
        superCloseArgsSchema.parse(input.args ?? {});
        const closed = await service.close({ sessionId: input.sessionId });
        if (!closed.ok) return toolResult(closed, "");
        const advanced = await service.advance(input.sessionId);
        const graph = advanced.graph ?? closed.graph;
        return {
          result: { ok: true, graph },
          displaySummary: advanced.ok
            ? "Closed the super graph and started verification."
            : `Closed the super graph, but verification did not start: ${advanced.code ?? "ERROR"} ${advanced.message ?? ""}`.trim(),
          artifacts: [],
        };
      },
    },
  ];
}
