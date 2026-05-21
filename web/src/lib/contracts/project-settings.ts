import { z } from 'zod'

export const ProjectSettingsVisibilitySchema = z.enum(['private', 'internal', 'public'])
export type ProjectSettingsVisibility = z.infer<typeof ProjectSettingsVisibilitySchema>

export const ProjectLifecycleStateSchema = z.enum(['active', 'archived'])
export type ProjectLifecycleState = z.infer<typeof ProjectLifecycleStateSchema>

export const ReviewPolicySchema = z.object({
  minApprovals: z.number().int().min(0).max(5),
  requireQaApproval: z.boolean(),
  requireOwnerApproval: z.boolean(),
  blockOnFailedCi: z.boolean(),
})
export type ReviewPolicy = z.infer<typeof ReviewPolicySchema>

export const NotificationChannelSchema = z.enum(['email', 'im', 'webhook', 'none'])
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>

export const NotificationSeveritySchema = z.enum(['info', 'warning', 'critical'])
export type NotificationSeverity = z.infer<typeof NotificationSeveritySchema>

export const NotificationPolicySchema = z.object({
  channel: NotificationChannelSchema,
  minSeverity: NotificationSeveritySchema,
  webhookUrl: z.string(),
  recipients: z.array(z.string().min(1)),
  quietHours: z.string(),
})
export type NotificationPolicy = z.infer<typeof NotificationPolicySchema>

export const ComplianceSettingsSchema = z.object({
  retentionDays: z.number().int().min(1).max(3650),
  auditLogEnabled: z.boolean(),
  dataExportAllowed: z.boolean(),
  piiMasking: z.boolean(),
})
export type ComplianceSettings = z.infer<typeof ComplianceSettingsSchema>

export const CollaborationSettingsSchema = z.object({
  agentsAllowDirectCommit: z.boolean(),
  reviewPolicy: ReviewPolicySchema,
})
export type CollaborationSettings = z.infer<typeof CollaborationSettingsSchema>

export const ProjectBasicsSchema = z.object({
  projectName: z.string().min(1),
  projectCode: z.string().min(1),
  environment: z.enum(['production', 'staging', 'development']),
  description: z.string(),
  visibility: ProjectSettingsVisibilitySchema,
  timezone: z.string().min(1),
  tags: z.array(z.string().min(1)).max(20),
  ownerMemberId: z.string().min(1),
})
export type ProjectBasics = z.infer<typeof ProjectBasicsSchema>

export const ProjectSettingsSchema = z.object({
  projectId: z.string().min(1),
  lifecycleState: ProjectLifecycleStateSchema,
  basics: ProjectBasicsSchema,
  collaboration: CollaborationSettingsSchema,
  notifications: NotificationPolicySchema,
  compliance: ComplianceSettingsSchema,
  updatedAt: z.string().min(1),
  updatedBy: z.string().min(1),
})
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>

export const GetProjectSettingsResponseSchema = z.object({
  settings: ProjectSettingsSchema,
})
export type GetProjectSettingsResponse = z.infer<typeof GetProjectSettingsResponseSchema>

export const UpdateProjectSettingsRequestSchema = z.object({
  basics: ProjectBasicsSchema,
  collaboration: CollaborationSettingsSchema,
  notifications: NotificationPolicySchema,
  compliance: ComplianceSettingsSchema,
})
export type UpdateProjectSettingsRequest = z.infer<typeof UpdateProjectSettingsRequestSchema>

export const HighRiskActionKindSchema = z.enum(['archive', 'restore', 'transfer', 'delete'])
export type HighRiskActionKind = z.infer<typeof HighRiskActionKindSchema>

export const HighRiskAuthEnvelopeSchema = z.object({
  confirmPhrase: z.string().min(1),
  securityCode: z.string().min(1),
  justification: z.string().min(8),
})
export type HighRiskAuthEnvelope = z.infer<typeof HighRiskAuthEnvelopeSchema>

export const ArchiveProjectRequestSchema = z.object({
  auth: HighRiskAuthEnvelopeSchema,
})
export type ArchiveProjectRequest = z.infer<typeof ArchiveProjectRequestSchema>

export const RestoreProjectRequestSchema = z.object({
  auth: HighRiskAuthEnvelopeSchema,
})
export type RestoreProjectRequest = z.infer<typeof RestoreProjectRequestSchema>

export const TransferProjectRequestSchema = z.object({
  newOwnerMemberId: z.string().min(1),
  auth: HighRiskAuthEnvelopeSchema,
})
export type TransferProjectRequest = z.infer<typeof TransferProjectRequestSchema>

export const DeleteProjectRequestSchema = z.object({
  auth: HighRiskAuthEnvelopeSchema,
})
export type DeleteProjectRequest = z.infer<typeof DeleteProjectRequestSchema>

export const HighRiskAuditEntrySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  kind: HighRiskActionKindSchema,
  operatorId: z.string().min(1),
  operatorName: z.string().min(1),
  justification: z.string().min(1),
  createdAt: z.string().min(1),
  outcome: z.enum(['success', 'rejected']),
  rejectReason: z.string().optional(),
})
export type HighRiskAuditEntry = z.infer<typeof HighRiskAuditEntrySchema>

export const HighRiskAuditListResponseSchema = z.object({
  entries: z.array(HighRiskAuditEntrySchema),
})
export type HighRiskAuditListResponse = z.infer<typeof HighRiskAuditListResponseSchema>
