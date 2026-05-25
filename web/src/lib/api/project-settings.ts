import { apiRequest } from './origin'
import type {
  ProjectSettings,
  UpdateProjectSettingsRequest,
  HighRiskAuthEnvelope,
} from '../contracts/project-settings'

export interface ProjectSettingsResponse {
  settings: ProjectSettings
}

export const projectSettingsApi = {
  async get(projectId: string): Promise<ProjectSettingsResponse> {
    return apiRequest<ProjectSettingsResponse>(`/api/projects/${encodeURIComponent(projectId)}/settings`)
  },

  async update(projectId: string, payload: UpdateProjectSettingsRequest): Promise<ProjectSettingsResponse> {
    return apiRequest<ProjectSettingsResponse>(`/api/projects/${encodeURIComponent(projectId)}/settings`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    })
  },

  async patchSection(projectId: string, section: string, data: unknown): Promise<ProjectSettingsResponse> {
    return apiRequest<ProjectSettingsResponse>(`/api/projects/${encodeURIComponent(projectId)}/settings/${section}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },

  async reset(projectId: string): Promise<void> {
    await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/settings`, { method: 'DELETE' })
  },

  async archive(projectId: string, auth: HighRiskAuthEnvelope): Promise<ProjectSettingsResponse> {
    return apiRequest<ProjectSettingsResponse>(`/api/projects/${encodeURIComponent(projectId)}/settings/archive`, {
      method: 'POST',
      body: JSON.stringify({ auth }),
    })
  },

  async restore(projectId: string, auth: HighRiskAuthEnvelope): Promise<ProjectSettingsResponse> {
    return apiRequest<ProjectSettingsResponse>(`/api/projects/${encodeURIComponent(projectId)}/settings/restore`, {
      method: 'POST',
      body: JSON.stringify({ auth }),
    })
  },

  async transfer(projectId: string, newOwnerMemberId: string, auth: HighRiskAuthEnvelope): Promise<ProjectSettingsResponse> {
    return apiRequest<ProjectSettingsResponse>(`/api/projects/${encodeURIComponent(projectId)}/settings/transfer`, {
      method: 'POST',
      body: JSON.stringify({ newOwnerMemberId, auth }),
    })
  },
}
