import { createHash } from "node:crypto";
import { z } from "zod";
import { agentRuntimeStore as store } from "./session-store.js";
import { skillAgentBridge } from "../skills/agent-bridge.js";
import { snapshotVisualization, withoutVisualizationDeclarations } from "./visualization-integration.js";
import { visualizationBlocks } from "./visualization-protocol.js";
import type { RegisteredTool, StructuredToolCall } from "./contracts.js";

export const presentationSchema = z.object({
  mode: z.enum(["text", "inline_visualization", "artifact"]),
  requirement: z.enum(["required", "preferred", "forbidden"]),
  source: z.enum(["explicit", "continuation", "inferred"]),
  reason: z.string().min(1).max(1000),
}).strict().refine(value => value.requirement !== "forbidden" || value.mode === "text", {
  message: "Forbidden previews must select text.",
});

type Decision = z.infer<typeof presentationSchema> & {
  inputId: string;
  skillId?: string;
  blocker?: string;
  repairAttempted?: boolean;
  repairMessage?: string;
  status: "selected" | "repairing" | "validated" | "failed";
};

function scope(sessionId: string) {
  const session = store.getSession(sessionId);
  if (!session.activeRunId) return undefined;
  const run = store.getRun(session.activeRunId);
  return { session, run, inputId: String(run.metadata.turnReferenceInputId ?? run.triggerMessageId ?? run.id) };
}

export function presentationDecision(sessionId: string): Decision | undefined {
  const current = scope(sessionId);
  const decision = current?.run.metadata.presentation as Decision | undefined;
  return decision?.inputId === current?.inputId ? decision : undefined;
}

function save(sessionId: string, decision: Decision) {
  const current = scope(sessionId);
  if (!current) throw new Error("Presentation requires an active run.");
  store.updateRun(current.run.id, { metadata: { ...current.run.metadata, presentation: decision } });
}

export const presentationTool: RegisteredTool = {
  id: "presentation.select",
  label: "Select response presentation",
  description: "Record response format independently of the task, using current user intent and relevant history. Use for requested, prohibited or helpful previews. Inline selection schedules the visualize skill through normal permissions; it does not authorize new work. New user input requires a new decision.",
  category: "task",
  internalGate: "none",
  mutability: "task",
  resumeBehavior: "auto",
  inputSchema: presentationSchema,
  execute(input) {
    const selected = presentationSchema.parse(input.args);
    const current = scope(input.sessionId);
    if (!current) throw new Error("Presentation requires an active run.");
    const previous = presentationDecision(input.sessionId);
    const skills = selected.mode === "inline_visualization"
      ? skillAgentBridge.listForPrompt({ profileId: current.session.profileId, projectId: current.session.projectId, activeSkillIds: [] })
      : [];
    const skill = skills.find(skill => skill.id === "synax-builtin/visualize") ?? skills.find(skill => skill.name.toLowerCase() === "visualize");
    const decision: Decision = {
      ...selected, inputId: current.inputId, status: "selected",
      ...(skill ? { skillId: skill.id } : {}),
      ...(selected.mode === "inline_visualization" && !skill ? { blocker: "Visualize skill is unavailable for this session." } : {}),
      // Re-selecting must not reset the completion retry budget.
      ...(previous?.repairAttempted ? { repairAttempted: true } : {}),
    };
    save(input.sessionId, decision);
    return { result: decision, displaySummary: `Presentation: ${selected.mode} (${selected.requirement}).`, artifacts: [] };
  },
};

/** Ordinary tool execution owns permissions, hooks, persistence and replay. */
export function pendingPresentationSkillLoads(sessionId: string): StructuredToolCall[] {
  const current = scope(sessionId);
  const decision = presentationDecision(sessionId);
  if (!current || decision?.mode !== "inline_visualization" || !decision.skillId) return [];
  const id = `turn_skill_${createHash("sha256").update(JSON.stringify([current.run.id, current.inputId, decision.skillId])).digest("hex").slice(0, 24)}`;
  if (store.listRunToolCalls(current.run.id).some(call => call.modelToolCallId === id)) return [];
  // Successful skill bodies are retained by buildLoopMessages, including across
  // compaction, subject to this same permission/profile check.
  if (store.listToolCalls(sessionId).some(call => {
    const result = call.outputRef as { id?: unknown; content?: unknown } | null;
    return call.toolId === "skill.load" && call.status === "completed" &&
      result?.id === decision.skillId && typeof result?.content === "string";
  }) && skillAgentBridge.canRetainForContext(sessionId, decision.skillId)) return [];
  return [{ id, toolId: "skill.load", args: { skillId: decision.skillId }, reason: "Prepare the selected inline visualization output." }];
}

/** One correction per user input. Invalid optional output also gets a concrete diagnostic. */
export function checkPresentationCompletion(sessionId: string, content: string): { retry?: string; content: string } {
  const decision = presentationDecision(sessionId);
  const declared = visualizationBlocks(content, true).length > 0;
  if (decision?.requirement === "forbidden") {
    return { content: withoutVisualizationDeclarations(content) };
  }
  if (!declared && (decision?.mode !== "inline_visualization" || decision.requirement !== "required")) return { content };
  const preview = snapshotVisualization(sessionId, content, "presentation-check");
  const error = preview?.error ?? (!preview?.html ? decision?.blocker ?? "没有生成有效的内联预览声明。" : undefined);
  if (!error) {
    if (decision) save(sessionId, { ...decision, status: "validated" });
    return { content };
  }
  if (decision && !decision.repairAttempted && !decision.blocker) {
    const retry = `The requested inline preview did not validate: ${error} Correct the preview using the loaded visualize skill and return the complete final answer. This is the only automatic repair attempt. If blocked by permissions or unavailable capabilities, explain the concrete blocker; do not claim success.`;
    save(sessionId, { ...decision, repairAttempted: true, repairMessage: retry, status: "repairing" });
    return { content: `${withoutVisualizationDeclarations(content)}\n\n交互预览校验未通过，正在修复：${error}`.trim(), retry };
  }
  if (decision) save(sessionId, { ...decision, status: "failed" });
  return { content: `${withoutVisualizationDeclarations(content)}\n\n交互预览未完成：${error}`.trim() };
}
