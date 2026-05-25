import type { ProviderConnection } from './config-types.js'

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
  providerConnection?: ProviderConnection | null
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
  collaboration?: Partial<CollaborationSettings>
  notifications?: Partial<NotificationSettings>
  compliance?: Partial<ComplianceSettings>
}

export type ProjectSettingsSection = 'basics' | 'provider' | 'collaboration' | 'notifications' | 'compliance'

export interface HighRiskAuthEnvelope {
  confirmPhrase: string
  securityCode: string
  justification: string
}

export function createDefaultProjectSettings(projectId: string, updatedBy = 'system'): ProjectSettings {
  const now = new Date().toISOString()
  return {
    projectId,
    version: 1,
    basics: {
      name: projectId,
      description: '',
      environment: 'development',
      visibility: 'private',
      tags: [],
      ownerMemberId: '',
    },
    provider: {},
    collaboration: {
      agentsAllowDirectCommit: false,
      reviewPolicy: {
        minApprovals: 1,
        requireQaApproval: false,
        requireOwnerApproval: false,
        blockOnFailedCi: true,
      },
    },
    notifications: {
      channel: 'none',
      minSeverity: 'critical',
      webhookUrl: '',
      recipients: [],
      quietHours: '',
    },
    compliance: {
      retentionDays: 90,
      auditLogEnabled: true,
      dataExportAllowed: false,
      piiMasking: true,
    },
    lifecycleState: 'active',
    updatedAt: now,
    updatedBy,
  }
}
