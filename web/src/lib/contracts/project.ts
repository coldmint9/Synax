import { z } from 'zod'

export const ProjectEnvironmentSchema = z.enum(['production', 'staging', 'development'])
export type ProjectEnvironment = z.infer<typeof ProjectEnvironmentSchema>

export const ProjectSourceSchema = z.object({
  kind: z.enum(['scratch', 'github', 'gitlab']),
  repo: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
})
export type ProjectSource = z.infer<typeof ProjectSourceSchema>

export const ProjectImportStateSchema = z.enum(['idle', 'syncing', 'ready', 'failed'])
export type ProjectImportState = z.infer<typeof ProjectImportStateSchema>

export const ProjectSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(['healthy', 'at_risk', 'blocked']),
  environment: ProjectEnvironmentSchema,
  healthScore: z.number().int().min(0).max(100),
  activeAgents: z.number().int().min(0),
  activeHumans: z.number().int().min(0),
  openRisks: z.number().int().min(0),
  updatedAt: z.string().min(1),
  source: ProjectSourceSchema.optional(),
  importState: ProjectImportStateSchema.optional(),
})
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>

export const CreateProjectFromRepoRequestSchema = z.object({
  repoFullName: z.string().min(1),
  branch: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  environment: ProjectEnvironmentSchema,
  importReadme: z.boolean(),
  importIssues: z.boolean(),
  subscribeWebhooks: z.boolean(),
  defaultAiIntegrationId: z.string().nullable(),
})
export type CreateProjectFromRepoRequest = z.infer<typeof CreateProjectFromRepoRequestSchema>

export const CreateProjectFromScratchRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  environment: ProjectEnvironmentSchema,
  defaultAiIntegrationId: z.string().nullable(),
})
export type CreateProjectFromScratchRequest = z.infer<typeof CreateProjectFromScratchRequestSchema>

