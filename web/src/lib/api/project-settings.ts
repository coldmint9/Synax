import type {
  ArchiveProjectRequest,
  DeleteProjectRequest,
  GetProjectSettingsResponse,
  HighRiskAuditListResponse,
  RestoreProjectRequest,
  ProjectSettings,
  TransferProjectRequest,
  UpdateProjectSettingsRequest,
} from '../contracts/project-settings'

const settingsByProject = new Map<string, ProjectSettings>()
const auditsByProject = new Map<string, HighRiskAuditListResponse['entries']>()

function defaultSettings(projectId: string): ProjectSettings {
  return {
    projectId,
    lifecycleState: 'active',
    basics: {
      projectName: projectId,
      projectCode: projectId.toUpperCase().slice(0, 6),
      environment: 'development',
      description: '',
      visibility: 'private',
      timezone: 'UTC',
      tags: [],
      ownerMemberId: 'u-alice',
    },
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
    updatedAt: 'just now',
    updatedBy: 'Alice Chen',
  }
}

export const projectSettingsApi = {
  async get(projectId: string): Promise<GetProjectSettingsResponse> {
    if (!settingsByProject.has(projectId)) {
      settingsByProject.set(projectId, defaultSettings(projectId))
    }
    return { settings: { ...settingsByProject.get(projectId)!, basics: { ...settingsByProject.get(projectId)!.basics } } }
  },

  async update(projectId: string, payload: UpdateProjectSettingsRequest, operator: string): Promise<GetProjectSettingsResponse> {
    const prev = settingsByProject.get(projectId) ?? defaultSettings(projectId)
    const next: ProjectSettings = {
      ...prev,
      basics: { ...payload.basics },
      collaboration: { ...payload.collaboration, reviewPolicy: { ...payload.collaboration.reviewPolicy } },
      notifications: { ...payload.notifications, recipients: [...payload.notifications.recipients] },
      compliance: { ...payload.compliance },
      updatedAt: 'just now',
      updatedBy: operator,
    }
    settingsByProject.set(projectId, next)
    return { settings: { ...next, basics: { ...next.basics } } }
  },

  async archive(
    projectId: string,
    _payload: ArchiveProjectRequest,
    _operatorId: string,
    operatorName: string,
  ): Promise<GetProjectSettingsResponse> {
    const s = settingsByProject.get(projectId) ?? defaultSettings(projectId)
    s.lifecycleState = 'archived'
    s.updatedAt = 'just now'
    s.updatedBy = operatorName
    settingsByProject.set(projectId, s)
    return { settings: { ...s, basics: { ...s.basics } } }
  },

  async restore(
    projectId: string,
    _payload: RestoreProjectRequest,
    _operatorId: string,
    operatorName: string,
  ): Promise<GetProjectSettingsResponse> {
    const s = settingsByProject.get(projectId) ?? defaultSettings(projectId)
    s.lifecycleState = 'active'
    s.updatedAt = 'just now'
    s.updatedBy = operatorName
    settingsByProject.set(projectId, s)
    return { settings: { ...s, basics: { ...s.basics } } }
  },

  async transfer(
    projectId: string,
    payload: TransferProjectRequest,
    _operatorId: string,
    operatorName: string,
  ): Promise<GetProjectSettingsResponse> {
    const s = settingsByProject.get(projectId) ?? defaultSettings(projectId)
    s.basics.ownerMemberId = payload.newOwnerMemberId
    s.updatedAt = 'just now'
    s.updatedBy = operatorName
    settingsByProject.set(projectId, s)
    return { settings: { ...s, basics: { ...s.basics } } }
  },

  async delete(projectId: string, _payload: DeleteProjectRequest, _operatorId: string, _operatorName: string) {
    settingsByProject.delete(projectId)
  },

  async listHighRiskAudits(projectId: string): Promise<HighRiskAuditListResponse> {
    return { entries: auditsByProject.get(projectId) ?? [] }
  },
}
