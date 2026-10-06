import type { AgentSession } from "../contracts.js";

export const NATIVE_PROTOCOL_IDS = new Set(["agent.discover"]);

/** Native execution is intrinsic; backend boundaries are not feature flags. */
export function nativeCapabilitiesEnabled(session: AgentSession): boolean {
  const backend = session.sessionMetadata?.backend as { id?: string } | undefined;
  return session.profileId !== "git-manager" &&
    (!backend?.id || backend.id === "native") &&
    !(!backend && session.sessionMetadata?.acp);
}

// A fixed core keeps common reads and workflow controls one step away. Other
// tools remain discoverable; this list never grants permission to use them.
export const CORE_TOOL_IDS = new Set([
  "agent.discover",
  "file.read", "file.list", "rg", "context.read", "diff.read",
  "file.write", "file.patch", "bash", "subagent.delegate",
  "task.create", "task.update", "task.get", "task.list",
  "human.ask", "plan.propose", "plan.execute", "mode.switch",
  "goal.finish", "work.checkpoint", "skill.load", "tools.invalid",
]);
