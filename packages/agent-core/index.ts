export { agentProtocolVersion } from "../agent-protocol/protocol-version.js";

export interface AgentExecutionContext {
  taskId: string;
  nodeId: string;
  signal?: AbortSignal;
  emit?: (text: string) => void;
}

export interface AgentExecutor<TInput = unknown, TResult = unknown> {
  execute(input: TInput, context: AgentExecutionContext): Promise<TResult>;
}

export { executeAgentTask } from "./task-execution.js";
export type { AgentTaskExecutionPorts } from "./task-execution.js";
