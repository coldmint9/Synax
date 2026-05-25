export type ProviderStatus = 'live' | 'experimental' | 'inactive'
export type ProviderKind = 'acp' | 'api'
export type ApiFormat = 'openai' | 'openai-responses' | 'anthropic'

export interface ProviderCaps {
  canFollowUp: boolean
  canCancel: boolean
}

export interface ProviderDef {
  id: string
  label: string
  description?: string
  status: ProviderStatus
  kind: ProviderKind
  caps: ProviderCaps
  models: ProviderModelDef[]
  connectionSchema?: Record<string, unknown>
}

export interface ProviderModelDef {
  id: string
  label: string
  isDefault?: boolean
  maxTokens?: number
}

export interface ProviderConnection {
  providerId: string
  baseUrl?: string
  apiKey?: string
  apiKeyMasked?: string
  extra?: Record<string, unknown>
}

export interface GlobalConfig {
  version: number
  providers: ProviderDef[]
  defaultProviderId: string
  defaultApiProviderId: string
  enabledAcpProviderIds: string[]
  providerConnections: Record<string, ProviderConnection>
  limits: {
    maxAgentsPerProject: number
    agentTimeoutMs: number
  }
  features: {
    allowProjectConnectionOverride: boolean
  }
  updatedAt: string
  updatedBy: string
}

export interface ProjectConfig {
  projectId: string
  version: number
  providerId?: string | null
  modelId?: string | null
  providerConnection?: ProviderConnection | null
  limits?: {
    maxAgentsPerProject?: number
    agentTimeoutMs?: number
  }
  custom?: Record<string, string>
  updatedAt: string
  updatedBy: string
}

export interface EffectiveConfig {
  providerId: string
  modelId: string
  provider: ProviderDef
  model: ProviderModelDef
  connection: ProviderConnection
  limits: GlobalConfig['limits']
}

export interface AnalyzerLlmConfig {
  providerId: string
  apiFormat: ApiFormat
  baseUrl: string
  apiKey?: string
  apiKeyMasked?: string
  model: string
}

export interface UpdateGlobalConfigRequest {
  providers?: ProviderDef[]
  defaultProviderId?: string
  defaultApiProviderId?: string
  enabledAcpProviderIds?: string[]
  providerConnections?: Record<string, ProviderConnection>
  limits?: GlobalConfig['limits']
  features?: GlobalConfig['features']
}

export interface UpdateProjectConfigRequest {
  providerId?: string | null
  modelId?: string | null
  providerConnection?: ProviderConnection | null
  limits?: ProjectConfig['limits']
  custom?: Record<string, string>
}

export interface GlobalConfigResponse {
  config: GlobalConfig
}

export interface ProjectConfigResponse {
  config: ProjectConfig | null
}

export interface EffectiveConfigResponse {
  config: EffectiveConfig
}

export interface AiApiModelsDiscoverRequest {
  providerId?: string
  format: ApiFormat
  baseUrl: string
  apiKey?: string
}

export interface AiApiModelsDiscoverResponse {
  ok: boolean
  models: string[]
  source: string
  error?: string
  resolvedBaseUrl?: string
}
