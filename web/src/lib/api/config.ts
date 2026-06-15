import type {
  AcpDiscoveryResponse,
  AiApiModelsDiscoverRequest,
  AiApiModelsDiscoverResponse,
  AiApiValidateRequest,
  AiApiValidateResponse,
  EffectiveConfigResponse,
  GlobalConfigResponse,
  ProjectConfigResponse,
  ProviderListResponse,
  UpdateGlobalConfigRequest,
  UpdateProjectConfigRequest,
} from '../contracts/config'
import { apiFetch } from './origin'

const BASE = '/api/config'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await apiFetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!resp.ok) {
    const body = await resp.text()
    let message: string | undefined
    try {
      const parsed = JSON.parse(body) as { error?: string }
      message = parsed.error
    } catch {
      message = undefined
    }
    throw new Error(message || `Config API error ${resp.status}: ${body}`)
  }
  return resp.json()
}

export const configApi = {
  async getGlobal(): Promise<GlobalConfigResponse> {
    return request<GlobalConfigResponse>(`${BASE}/global`)
  },

  async updateGlobal(patch: UpdateGlobalConfigRequest): Promise<GlobalConfigResponse> {
    return request<GlobalConfigResponse>(`${BASE}/global`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
  },

  async listProviders(): Promise<ProviderListResponse> {
    return request<ProviderListResponse>(`${BASE}/global/providers`)
  },

  async discoverAcp(): Promise<AcpDiscoveryResponse> {
    return request<AcpDiscoveryResponse>(`${BASE}/acp/discovery`)
  },

  async validateAiApi(payload: AiApiValidateRequest): Promise<AiApiValidateResponse> {
    const resp = await apiFetch(`${BASE}/ai-api/validate`, {
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      body: JSON.stringify(payload),
    })
    const body = await resp.json().catch(() => ({ ok: false, error: `validate failed (${resp.status})` }))
    return body as AiApiValidateResponse
  },

  async discoverAiModels(payload: AiApiModelsDiscoverRequest): Promise<AiApiModelsDiscoverResponse> {
    const resp = await apiFetch(`${BASE}/ai-api/models/discover`, {
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      body: JSON.stringify(payload),
    })
    const body = await resp.json().catch(() => ({
      ok: false,
      models: [],
      source: 'api/models',
      error: `discover models failed (${resp.status})`,
    }))
    return body as AiApiModelsDiscoverResponse
  },

  async getProject(projectId: string): Promise<ProjectConfigResponse> {
    return request<ProjectConfigResponse>(`${BASE}/projects/${projectId}/config`)
  },

  async updateProject(projectId: string, patch: UpdateProjectConfigRequest): Promise<ProjectConfigResponse> {
    return request<ProjectConfigResponse>(`${BASE}/projects/${projectId}/config`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
  },

  async deleteProject(projectId: string): Promise<{ deleted: boolean }> {
    return request<{ deleted: boolean }>(`${BASE}/projects/${projectId}/config`, {
      method: 'DELETE',
    })
  },

  async getEffective(projectId: string): Promise<EffectiveConfigResponse> {
    return request<EffectiveConfigResponse>(`${BASE}/projects/${projectId}/config/effective`)
  },

  async openFile(filePath: string, line?: number): Promise<void> {
    await request<{ ok: true }>(`${BASE}/open-file`, {
      method: 'POST',
      body: JSON.stringify({ filePath, ...(line != null ? { line } : {}) }),
    })
  },
}
