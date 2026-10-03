import { z } from "zod";
import { agentProtocolVersion } from "./protocol-version.js";
import type { AgentCapabilityRequest, AgentNodeIdentity, AgentTaskRequest } from "./index.js";

const identifier = z.string().trim().min(1).max(256);

export const agentNodeIdentitySchema: z.ZodType<AgentNodeIdentity> = z.object({
  nodeId: identifier,
  kind: z.enum(["local", "cloud"]),
  protocolVersion: z.literal(agentProtocolVersion),
}).strict();

export const agentCapabilityRequestSchema: z.ZodType<AgentCapabilityRequest> = z.object({
  capability: identifier,
  risk: z.enum(["read", "write", "execute", "admin"]),
  resource: z.string().min(1).max(8192).optional(),
  reason: z.string().max(8192).optional(),
}).strict();

export const agentTaskRequestSchema: z.ZodType<AgentTaskRequest> = z.object({
  protocolVersion: z.literal(agentProtocolVersion),
  taskId: identifier,
  source: agentNodeIdentitySchema,
  target: agentNodeIdentitySchema.optional(),
  prompt: z.string().trim().min(1).max(1_000_000),
  capabilities: z.array(agentCapabilityRequestSchema).max(256).optional(),
}).strict();
