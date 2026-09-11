import type { AgentSession, RegisteredTool } from "./contracts.js";
import { agentRuntimeStore as store } from "./session-store.js";
import {
  inferSynaxSessionMode,
  isSynaxProfile,
} from "./synax/synax-session-mode.js";

export const CONTROL_TOOLS = new Set([
  "human.ask",
  "plan.propose",
  "goal.finish",
]);
const PLAN_TOOLS = new Set([
  "file.read",
  "file.list",
  "file.glob",
  "grep.search",
  "diff.read",
  "wiki.get_snapshot",
  "wiki.get_tree",
  "wiki.search_content",
  "wiki.search_batch",
  "wiki.read_document",
  "wiki.read_section",
  "wiki.get_references",
  "task.create",
  "task.update",
  "task.get",
  "task.list",
  "skill.load",
  "agent.adapt",
  "subagent.delegate",
  "human.ask",
  "plan.propose",
  "goal.finish",
  "tools.invalid",
]);
export function controlRoot(session: AgentSession): AgentSession {
  const seen = new Set<string>();
  let root = session;
  while (root.parentSessionId) {
    if (seen.has(root.id)) throw new Error("Cyclic session parent.");
    seen.add(root.id);
    root = store.getSession(root.parentSessionId);
  }
  return root;
}
export function controlToolError(
  session: AgentSession,
  tool: Pick<RegisteredTool, "id">,
  args?: unknown,
): string | null {
  const root = controlRoot(session);
  if (!isSynaxProfile(root.profileId))
    return CONTROL_TOOLS.has(tool.id)
      ? "Human/goal controls are only available in native Synax sessions."
      : null;
  if (session.parentSessionId && CONTROL_TOOLS.has(tool.id))
    return "Return questions or blockers to the primary agent instead.";
  const mode = inferSynaxSessionMode(root);
  if (
    (session.parentSessionId ||
      mode === "plan" ||
      (mode === "goal" && root.sessionMetadata?.goal)) &&
    root.status !== "running"
  )
    return "The controlling session is not running; execution is suspended.";
  const plan = root.sessionMetadata?.plan as { status?: string } | undefined;
  const planning =
    mode === "plan" || (mode === "goal" && plan?.status !== "approved");
  if (planning && !PLAN_TOOLS.has(tool.id))
    return "Planning is read-only. Submit a plan with plan.propose and wait for user approval before executing.";
  if (
    mode === "goal" &&
    plan?.status === "approved" &&
    tool.id === "task.create"
  )
    return "Plan structure is frozen. Propose a revised plan before adding tasks.";
  if (
    mode === "goal" &&
    plan?.status === "approved" &&
    tool.id === "task.update" &&
    (args as { status?: string } | undefined)?.status === "deleted"
  )
    return "Approved plan tasks cannot be deleted; propose a revised plan.";
  if (
    mode === "goal" &&
    plan?.status === "approved" &&
    tool.id === "task.update" &&
    args &&
    typeof args === "object" &&
    Object.keys(args).some(
      (k) => !["taskId", "status", "activeForm", "owner"].includes(k),
    )
  )
    return "Plan structure is frozen. Only task progress may change without a revised plan.";
  return null;
}
export function validateControlBatch(
  calls: ReadonlyArray<{ toolId: string }>,
): string | null {
  return calls.length > 1 && calls.some((c) => CONTROL_TOOLS.has(c.toolId))
    ? "Control tools (human.ask, plan.propose, goal.finish) must be the only call in a step. No tools in this batch were executed."
    : null;
}
