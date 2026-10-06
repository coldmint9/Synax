import type { AgentSession } from "../contracts.js";

export const NATIVE_PROTOCOL_IDS = new Set(["agent.discover", "agent.execute"]);

/** Rollback restores the legacy model tool surface without changing grants. */
export function nativeCapabilitiesEnabled(session: AgentSession): boolean {
  const backend = session.sessionMetadata?.backend as { id?: string } | undefined;
  return process.env.SYNAX_NATIVE_CAPABILITIES === "1" &&
    session.profileId !== "git-manager" &&
    (!backend?.id || backend.id === "native") &&
    !(!backend && session.sessionMetadata?.acp);
}

// A fixed core keeps common reads and workflow controls one step away. Other
// tools remain discoverable; this list never grants permission to use them.
export const CORE_TOOL_IDS = new Set([
  ...NATIVE_PROTOCOL_IDS,
  "file.read", "file.list", "rg", "context.read", "diff.read",
  "human.ask", "plan.propose", "plan.execute", "mode.switch",
  "goal.finish", "work.checkpoint", "skill.load", "tools.invalid",
]);
