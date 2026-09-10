import type { McpServerConfig } from './config'

export type ProjectVisibility = 'private' | 'internal' | 'public'
export type ProjectLifecycleState = 'active' | 'archived'
export type NotificationChannel = 'email' | 'im' | 'webhook' | 'none'
export type NotificationSeverity = 'info' | 'warning' | 'critical'

export interface ReviewPolicy {
  minApprovals: number
  requireQaApproval: boolean
  requireOwnerApproval: boolean
  blockOnFailedCi: boolean
}

export interface ProjectBasics {
  name: string
  description: string
  environment: 'production' | 'staging' | 'development'
  visibility: ProjectVisibility
  tags: string[]
  ownerMemberId: string
}

export interface ProjectProviderOverride {
  providerId?: string | null
  modelId?: string | null
  providerConnection?: import('./config').ProviderConnection | null
  limits?: {
    maxAgentsPerProject?: number
    agentTimeoutMs?: number
  }
}

export interface CollaborationSettings {
  agentsAllowDirectCommit: boolean
  reviewPolicy: ReviewPolicy
}

export interface NotificationSettings {
  channel: NotificationChannel
  minSeverity: NotificationSeverity
  webhookUrl: string
  recipients: string[]
  quietHours: string
}

export interface ComplianceSettings {
  retentionDays: number
  auditLogEnabled: boolean
  dataExportAllowed: boolean
  piiMasking: boolean
}

export interface ProjectSettings {
  projectId: string
  version: number
  basics: ProjectBasics
  provider: ProjectProviderOverride
  mcpServers: McpServerConfig[]
  collaboration: CollaborationSettings
  notifications: NotificationSettings
  compliance: ComplianceSettings
  lifecycleState: ProjectLifecycleState
  updatedAt: string
  updatedBy: string
}

export interface UpdateProjectSettingsRequest {
  basics?: Partial<ProjectBasics>
  provider?: Partial<ProjectProviderOverride>
  mcpServers?: McpServerConfig[]
  collaboration?: Partial<CollaborationSettings>
  notifications?: Partial<NotificationSettings>
  compliance?: Partial<ComplianceSettings>
}

export interface HighRiskAuthEnvelope {
  confirmPhrase: string
  securityCode: string
  justification: string
}
