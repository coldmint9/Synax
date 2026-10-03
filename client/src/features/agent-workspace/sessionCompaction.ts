import type {
  AgentSession,
  ContextCompactionState,
} from "../../adapters/transport/agentRuntime";

export function sessionCompaction(
  session?: AgentSession,
): ContextCompactionState | undefined {
  return session?.sessionMetadata?.contextCompaction as
    | ContextCompactionState
    | undefined;
}
