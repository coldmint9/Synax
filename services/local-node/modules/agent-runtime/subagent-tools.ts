import * as z from "zod/v4";
import type { RegisteredTool, ToolExecutionInput, ToolExecutionResult } from "./contracts.js";
import { AgentValidationError } from "./runtime-errors.js";
import { agentRuntimeStore } from "./session-store.js";
import { agentSessionRuntime } from "./session-runtime.js";
import {
  getSubagentLiveness,
  runChildToCompletion,
  type SubagentSpec,
} from "./subagent-orchestrator.js";
import { nowIso } from "./runtime-ids.js";
import { interruptAgentSessionsAndWait } from "./agent-stream-proxy.js";

const activeRuns = new Set<string>();
const terminalStatuses = new Set(["completed", "failed", "cancelled", "interrupted"]);

const lifecycleArgsSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    prompt: z.string().trim().min(1).max(100_000),
    profileId: z.enum(["explorer", "reviewer"]).default("explorer"),
    name: z.string().trim().min(1).max(200).optional(),
    thinkingMode: z.enum(["fast", "standard", "deep"]).optional(),
  }),
  z.object({ action: z.literal("list") }),
  z.object({
    action: z.enum(["inspect", "wait", "message", "pause", "resume", "cancel", "terminate", "close"]),
    childSessionId: z.string().min(1).max(64),
    timeoutMs: z.number().int().min(0).max(30_000).default(5_000).optional(),
    message: z.string().trim().min(1).max(100_000).optional(),
    reason: z.string().trim().min(1).max(4_000).optional(),
  }),
]);

type LifecycleArgs = z.infer<typeof lifecycleArgsSchema>;

function assertOwnedChild(parentSessionId: string, childSessionId: string) {
  const child = agentRuntimeStore.tryGetSession(childSessionId);
  if (!child || child.parentSessionId !== parentSessionId)
    throw new AgentValidationError(
      "The requested subagent is not a child of the current session.",
    );
  return child;
}

function childView(childSessionId: string, parentSessionId: string) {
  const child = assertOwnedChild(parentSessionId, childSessionId);
  const metadata = child.sessionMetadata?.subagentTask as
    | Record<string, unknown>
    | undefined;
  return {
    childSessionId: child.id,
    parentSessionId: child.parentSessionId,
    profileId: child.profileId,
    name: child.sessionMetadata?.subagentName ?? null,
    status: child.status,
    liveness: getSubagentLiveness(child.status, metadata),
    summary: child.resultSummary ?? null,
    error: child.blockedReason ?? null,
    metadata: metadata ?? null,
    activeRunId: child.activeRunId,
  };
}

function result(result: unknown, displaySummary: string): ToolExecutionResult {
  return { result, displaySummary, artifacts: [] };
}

async function waitForChild(
  parentSessionId: string,
  childSessionId: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let child = assertOwnedChild(parentSessionId, childSessionId);
  while (!terminalStatuses.has(child.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    child = assertOwnedChild(parentSessionId, childSessionId);
  }
  return childView(childSessionId, parentSessionId);
}

function startChild(input: ToolExecutionInput, args: Extract<LifecycleArgs, { action: "start" }>) {
  const parent = agentRuntimeStore.getSession(input.sessionId);
  if (parent.parentSessionId)
    throw new AgentValidationError("Only a primary agent can control subagent lifecycles.");
  if (["stopping", "paused", "interrupted", "cancelled"].includes(parent.status))
    throw new AgentValidationError("A stopped primary session cannot start a subagent.");
  const activeChildren = (parent.childSessionIds ?? [])
    .map((id) => agentRuntimeStore.tryGetSession(id))
    .filter((child) => child && !terminalStatuses.has(child.status));
  if (activeChildren.length >= 5)
    throw new AgentValidationError("Maximum concurrent subagents (5) reached.");

  const child = agentSessionRuntime.create({
    projectId: parent.projectId,
    sessionMetadata: { mode: parent.sessionMetadata?.mode ?? "chat", subagentName: args.name ?? null },
    mcpServerIds: parent.mcpServerIds,
    skillIds: parent.skillIds,
    nodeId: parent.nodeId,
    profileId: args.profileId,
    parentSessionId: parent.id,
    prompt: args.prompt,
    thinkingMode: args.thinkingMode,
  });
  const spec: SubagentSpec = {
    profileId: args.profileId,
    prompt: args.prompt,
    nodeId: parent.nodeId,
    thinkingMode: args.thinkingMode,
    label: args.name,
  };
  agentRuntimeStore.updateSessionMetadata(child.id, {
    subagentTask: { state: "queued", phase: "queued", startedAt: nowIso() },
  });
  activeRuns.add(child.id);
  void runChildToCompletion(child.id, spec).catch(() => undefined).finally(() => activeRuns.delete(child.id));
  return childView(child.id, parent.id);
}

export const subagentLifecycleTool: RegisteredTool = {
  id: "subagent.lifecycle",
  label: "Control Subagent",
  description:
    "Control the full lifecycle of a subagent owned by the current primary agent: start, list, inspect, wait, message, pause, resume, cancel, close, or terminate. Lifecycle actions are limited to direct child sessions.",
  progressiveDetails:
    "Use start for asynchronous work when the parent should continue. pause is resumable, cancel is terminal, close and terminate are hard stops, and message continues a stopped or completed child with new input. Always use the returned childSessionId for later actions.",
  category: "task",
  internalGate: "task",
  mutability: "task",
  resumeBehavior: "auto",
  inputSchema: lifecycleArgsSchema,
  async execute(input) {
    const args = lifecycleArgsSchema.parse(input.args);
    if (args.action === "start")
      return result(startChild(input, args), "Started asynchronous subagent.");
    if (args.action === "list") {
      const parent = agentRuntimeStore.getSession(input.sessionId);
      if (parent.parentSessionId)
        throw new AgentValidationError("Only a primary agent can list subagents.");
      return result(
        (parent.childSessionIds ?? []).map((id) => childView(id, parent.id)),
        "Listed owned subagents.",
      );
    }

    const child = assertOwnedChild(input.sessionId, args.childSessionId);
    if (args.action === "inspect")
      return result(childView(child.id, input.sessionId), "Inspected subagent.");
    if (args.action === "wait")
      return result(
        await waitForChild(input.sessionId, child.id, args.timeoutMs ?? 5_000),
        "Waited for subagent.",
      );
    if (args.action === "message") {
      if (!args.message) throw new AgentValidationError("message is required.");
      if (activeRuns.has(child.id) && !terminalStatuses.has(child.status))
        throw new AgentValidationError("The subagent is already running; wait or pause it before messaging it.");
      agentRuntimeStore.updateSessionMetadata(child.id, { manualStop: null });
      agentRuntimeStore.updateSession(child.id, { prompt: args.message, status: "queued", updatedAt: nowIso(), completedAt: null });
      const spec: SubagentSpec = { profileId: child.profileId, prompt: args.message, nodeId: child.nodeId };
      activeRuns.add(child.id);
      void runChildToCompletion(child.id, spec, { input: { message: args.message } }).catch(() => undefined).finally(() => activeRuns.delete(child.id));
      return result(childView(child.id, input.sessionId), "Sent a new instruction to subagent.");
    }
    if (args.action === "resume") {
      if (!["paused", "interrupted", "completed"].includes(child.status))
        throw new AgentValidationError(`Cannot resume subagent in status ${child.status}.`);
      agentRuntimeStore.updateSessionMetadata(child.id, { manualStop: null });
      agentRuntimeStore.updateSession(child.id, { status: "queued", updatedAt: nowIso(), completedAt: null });
      const spec: SubagentSpec = { profileId: child.profileId, prompt: child.prompt, nodeId: child.nodeId };
      activeRuns.add(child.id);
      void runChildToCompletion(child.id, spec, { resume: true }).catch(() => undefined).finally(() => activeRuns.delete(child.id));
      return result(childView(child.id, input.sessionId), "Resumed subagent.");
    }
    const reason = args.reason ?? `Subagent ${args.action} by parent agent.`;
    if (args.action === "pause") {
      if (terminalStatuses.has(child.status)) throw new AgentValidationError("A terminal subagent cannot be paused.");
      await interruptAgentSessionsAndWait([child.id], reason);
      activeRuns.delete(child.id);
      return result(agentSessionRuntime.cancel(child.id), "Paused subagent.");
    }
    if (args.action === "cancel") {
      if (terminalStatuses.has(child.status)) return result(childView(child.id, input.sessionId), "Subagent already stopped.");
      await interruptAgentSessionsAndWait([child.id], reason);
      activeRuns.delete(child.id);
      agentSessionRuntime.interrupt(child.id);
      agentRuntimeStore.updateSession(child.id, { status: "cancelled", updatedAt: nowIso(), completedAt: nowIso(), resultSummary: reason });
      return result(childView(child.id, input.sessionId), "Cancelled subagent.");
    }
    await interruptAgentSessionsAndWait([child.id], reason);
    activeRuns.delete(child.id);
    agentSessionRuntime.interrupt(child.id);
    return result(childView(child.id, input.sessionId), "Terminated subagent.");
  },
};

export const subagentLifecycleTools = [subagentLifecycleTool];
