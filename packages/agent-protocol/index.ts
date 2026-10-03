import { agentProtocolVersion } from "./protocol-version.js";

export { agentProtocolVersion, negotiateProtocolVersion } from "./protocol-version.js";
export { agentTaskRequestSchema, agentNodeIdentitySchema, agentCapabilityRequestSchema } from "./task-schema.js";

export type AgentNodeKind = "local" | "cloud";

export type AgentCapabilityRisk = "read" | "write" | "execute" | "admin";

export interface AgentNodeIdentity {
  nodeId: string;
  kind: AgentNodeKind;
  protocolVersion: string;
}

export interface AgentCapabilityRequest {
  capability: string;
  risk: AgentCapabilityRisk;
  resource?: string;
  reason?: string;
}

export interface AgentTaskRequest {
  protocolVersion: typeof agentProtocolVersion;
  taskId: string;
  source: AgentNodeIdentity;
  target?: AgentNodeIdentity;
  prompt: string;
  capabilities?: AgentCapabilityRequest[];
}

export type AgentTaskEvent =
  | { type: "accepted"; taskId: string; at: string }
  | { type: "started"; taskId: string }
  | { type: "capability-requested"; taskId: string; request: AgentCapabilityRequest }
  | { type: "capability-resolved"; taskId: string; capability: string; allowed: boolean }
  | { type: "output"; taskId: string; text: string }
  | { type: "completed"; taskId: string; result?: unknown }
  | { type: "failed"; taskId: string; code: string; message: string }
  | { type: "cancelled"; taskId: string };

export interface AgentEventEnvelope {
  protocolVersion: typeof agentProtocolVersion;
  sequence: number;
  nodeId: string;
  event: AgentTaskEvent;
}
