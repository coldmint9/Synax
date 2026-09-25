import { workRuntime } from './work-runtime.js';
import type { AgentSession, RegisteredTool } from "./contracts.js";
import { controlRoot } from "./workflow-mode.js";
export { controlRoot } from "./workflow-mode.js";
import {
  inferSynaxSessionMode,
  isSynaxProfile,
} from "./synax/synax-session-mode.js";
import { isToolMountedForSession, isPlanningReadTool } from "./tool-mount-policy.js";

export const CONTROL_TOOLS = new Set([
  "human.ask",
  "plan.propose",
  "plan.execute",
  "mode.switch",
  "goal.finish",
  "work.checkpoint",
  "design.implement",
]);
export function controlToolError(
  session: AgentSession,
  tool: Pick<RegisteredTool, "id">,
  args?: unknown,
): string | null {
  if (!isToolMountedForSession(session, tool)) {
    if (["work.checkpoint", "goal.finish", "verification.run"].includes(tool.id))
      return `Tool ${tool.id} is only available in goal mode.`;
    if (inferSynaxSessionMode(controlRoot(session)) === "plan")
      return "Planning is read-only. Approve a plan before executing changes.";
    return `Tool ${tool.id} requires plan/goal mode or, for plan.execute, a saved plan and explicit execution intent.`;
  }
  const workError = workRuntime.toolError(session.id, tool.id, args);
  if (workError) return workError;
  const root = controlRoot(session);
  if (root.profileId === 'git-manager' && tool.id === 'human.ask' && !session.parentSessionId) return null;
  if (!isSynaxProfile(root.profileId))
    return CONTROL_TOOLS.has(tool.id) && tool.id !== "work.checkpoint"
      ? "Human/goal controls are only available in native Synax sessions."
      : null;
  if (session.parentSessionId && CONTROL_TOOLS.has(tool.id) && tool.id !== "work.checkpoint")
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
  if (planning && !isPlanningReadTool(tool.id))
    return "Planning is read-only. Submit a plan with plan.propose and wait for the user's execute choice or a later explicit execution instruction.";
  if (
    mode === "goal" && plan?.status === "approved" &&
    tool.id === "task.create"
  )
    return "Plan structure is frozen. Propose a revised plan before adding tasks.";
  if (
    mode === "goal" && plan?.status === "approved" &&
    tool.id === "task.update" &&
    (args as { status?: string } | undefined)?.status === "deleted"
  )
    return "Approved plan tasks cannot be deleted; propose a revised plan.";
  if (
    mode === "goal" && plan?.status === "approved" &&
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
    ? "Control tools (human.ask, plan.propose, plan.execute, mode.switch, goal.finish, work.checkpoint, design.implement) must be the only call in a step. No tools in this batch were executed."
    : null;
}
