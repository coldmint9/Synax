import type {
  AgentCapabilityRequest,
  AgentNodeIdentity,
  AgentTaskRequest,
} from "../../packages/agent-protocol/index.js";
import {
  decideCapability,
  type CapabilityPolicy,
} from "../../packages/capabilities/index.js";
import { agentNodeIdentitySchema, agentTaskRequestSchema, agentProtocolVersion } from "../../packages/agent-protocol/index.js";

export interface AgentNodeRuntime {
  identity: AgentNodeIdentity;
  createTask(prompt: string, capabilities?: AgentCapabilityRequest[]): AgentTaskRequest;
  decide(request: AgentCapabilityRequest): ReturnType<typeof decideCapability>;
}

export function createAgentNode(
  identity: AgentNodeIdentity,
  policy: CapabilityPolicy,
): AgentNodeRuntime {
  const validatedIdentity = agentNodeIdentitySchema.parse(identity);
  return {
    identity: validatedIdentity,
    createTask(prompt, capabilities = []) {
      return agentTaskRequestSchema.parse({
        protocolVersion: agentProtocolVersion,
        taskId: crypto.randomUUID(),
        source: validatedIdentity,
        prompt,
        capabilities,
      });
    },
    decide: (request) => decideCapability(request, policy),
  };
}
