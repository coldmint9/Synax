import type {
  AgentSession,
  ContextCompactionState,
} from "../../../lib/api/agentRuntime";

export function sessionCompaction(
  session?: AgentSession,
): ContextCompactionState | undefined {
  return session?.sessionMetadata?.contextCompaction as
    | ContextCompactionState
    | undefined;
}
