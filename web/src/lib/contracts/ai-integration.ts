// ── DEPRECATED (2026-04-28) ───────────────────────────────────────────────
// 本文件已废弃。类型定义已迁移到 web/src/lib/contracts/config.ts。
// 保留用于向后兼容旧代码，新代码请使用 config.ts。
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod'
import { ExecRoleTypeSchema } from './team'

export const AiProviderKeySchema = z.enum(['openai', 'anthropic', 'gemini', 'azure-openai', 'custom'])
export type AiProviderKey = z.infer<typeof AiProviderKeySchema>

export const AiIntegrationStatusSchema = z.enum(['active', 'inactive'])
export type AiIntegrationStatus = z.infer<typeof AiIntegrationStatusSchema>

export const AiIntegrationSchema = z.object({
  id: z.string().min(1),
  provider: AiProviderKeySchema,
  name: z.string().min(1),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  apiKeyMasked: z.string().min(1),
  status: AiIntegrationStatusSchema,
  isDefault: z.boolean(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  createdBy: z.string().min(1),
})
export type AiIntegration = z.infer<typeof AiIntegrationSchema>

export const UpsertAiIntegrationRequestSchema = z.object({
  provider: AiProviderKeySchema,
  name: z.string().min(1),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  apiKey: z.string().min(1),
})
export type UpsertAiIntegrationRequest = z.infer<typeof UpsertAiIntegrationRequestSchema>

export const UpdateAiIntegrationStatusRequestSchema = z.object({
  status: AiIntegrationStatusSchema,
})
export type UpdateAiIntegrationStatusRequest = z.infer<typeof UpdateAiIntegrationStatusRequestSchema>

export const AiIntegrationListResponseSchema = z.object({
  items: z.array(AiIntegrationSchema),
})
export type AiIntegrationListResponse = z.infer<typeof AiIntegrationListResponseSchema>

export const AgentApiBindingSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  roleType: ExecRoleTypeSchema,
  agentKey: z.string().min(1),
  integrationId: z.string().min(1),
  updatedAt: z.string().min(1),
  updatedBy: z.string().min(1),
})
export type AgentApiBinding = z.infer<typeof AgentApiBindingSchema>

export const UpsertAgentApiBindingRequestSchema = z.object({
  projectId: z.string().min(1),
  roleType: ExecRoleTypeSchema,
  agentKey: z.string().min(1),
  integrationId: z.string().min(1),
})
export type UpsertAgentApiBindingRequest = z.infer<typeof UpsertAgentApiBindingRequestSchema>

export const AgentApiBindingListResponseSchema = z.object({
  items: z.array(AgentApiBindingSchema),
})
export type AgentApiBindingListResponse = z.infer<typeof AgentApiBindingListResponseSchema>