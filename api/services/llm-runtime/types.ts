import type { ModelMessage } from '@ai-sdk/provider-utils'
import type { ToolCallRepairFunction, ToolChoice, ToolSet } from 'ai'
import type { GlobalConfig, ProjectConfig } from '../../lib/config/config-types.js'
import type { LlmHookContext } from './llm-hooks.js'

export type LlmPurpose =
  | 'analyze'
  | 'reanalyze'
  | 'semantic'
  | 'seed'
  | 'review'
  | 'wiki'
  | 'context-signal'
  | 'validate'

export interface ModelsDevModel {
  id: string
  name?: string
  family?: string
  reasoning?: boolean
  tool_call?: boolean
  limit?: {
    context?: number
    output?: number
  }
}

export interface ModelsDevProvider {
  id: string
  name: string
  npm?: string
  api?: string
  env?: string[]
  doc?: string
  models: Record<string, ModelsDevModel>
}

export interface RuntimeModel {
  id: string
  label: string
  isDefault?: boolean
  maxTokens?: number
  contextLimit?: number
  toolCall?: boolean
  reasoning?: boolean
}

export interface RuntimeProvider {
  id: string
  label: string
  description?: string
  npm?: string
  api?: string
  env: string[]
  doc?: string
  supported: boolean
  models: RuntimeModel[]
}

export interface RuntimeCatalog {
  providers: RuntimeProvider[]
  fetchedAt: string
  source: 'remote' | 'cache' | 'snapshot'
}

export type LlmGatewayMessage =
  | { role: 'system'; content: string }
  | Extract<ModelMessage, { role: 'user' | 'assistant' | 'tool' }>

export interface LlmGatewayRequest {
  projectId?: string
  purpose: LlmPurpose | string
  model?: string
  messages: LlmGatewayMessage[]
  temperature?: number
  /** DeepSeek thinking strength when thinking mode is enabled. */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  maxTokens?: number
  stop?: string[]
  tools?: ToolSet
  toolChoice?: ToolChoice<ToolSet>
  activeTools?: string[]
  maxRetries?: number
  repairToolCall?: ToolCallRepairFunction<ToolSet>
  cacheControl?: boolean
  hookContext?: LlmHookContext
}

export interface LlmGatewayConfig {
  backend?: 'Synax-gateway' | 'mock'
  purpose: LlmPurpose | string
  projectId?: string
  model?: string
  smallModel?: boolean
}

export interface ModelOverrideConfig {
  label?: string
}

export interface ResolvedProviderConfig {
  providerId: string
  baseUrl?: string
  apiKey?: string
  apiKeyMasked?: string
  options?: Record<string, unknown>
  whitelist?: string[]
  blacklist?: string[]
  models?: Record<string, ModelOverrideConfig>
}

export interface ResolvedModelSelection {
  model: string
  providerId: string
  modelId: string
  provider: RuntimeProvider
  modelDef: RuntimeModel
  config: ResolvedProviderConfig
}

export interface ResolveLlmSelectionInput {
  catalog: RuntimeCatalog
  globalConfig: GlobalConfig
  projectConfig?: ProjectConfig | null
  purpose: string
  modelOverride?: string | null
  useSmallModel?: boolean
}

export interface ValidateLlmRequest {
  providerId?: string
  model: string
  baseUrl?: string
  apiKey?: string
  options?: Record<string, unknown>
}
