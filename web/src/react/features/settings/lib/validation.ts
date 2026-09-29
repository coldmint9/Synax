import type { ApiProviderDraft } from './providerPresets'

export function isValidUrl(url: string): boolean {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

export interface FieldError {
  field: string
  message: string
}

export function validateProviderDraft(draft: ApiProviderDraft): FieldError[] {
  const errors: FieldError[] = []
  if (!draft.apiKey.trim() && !draft.apiKeyMasked.trim()) {
    errors.push({ field: 'apiKey', message: 'API Key 不能为空' })
  }
  if (draft.custom && !draft.baseUrl.trim()) {
    errors.push({ field: 'baseUrl', message: 'Base URL 不能为空' })
  }
  if (draft.baseUrl && !isValidUrl(draft.baseUrl)) {
    errors.push({ field: 'baseUrl', message: '无效的 URL 格式' })
  }
  if (!draft.model.trim()) {
    errors.push({ field: 'model', message: '模型不能为空' })
  }
  for (const modelId of new Set([...draft.models, draft.model].filter(Boolean))) {
    const metadata = draft.modelMeta[modelId]
    const capabilities = metadata?.capabilities ?? []
    for (const [capability, output] of [
      ['image_generation', 'image'],
      ['video_generation', 'video'],
    ] as const) {
      if (capabilities.includes(capability) && !metadata?.media?.operations.some((operation) => operation.endsWith(output))) {
        errors.push({ field: 'model', message: `${modelId} 缺少${output === 'image' ? '生图' : '生视频'}操作` })
      }
    }
    if (capabilities.some((capability) => capability !== 'chat') && !draft.mediaAdapter && !['openai', 'openrouter', 'xai', 'ark', 'volc', 'minimax'].some((id) => draft.id.includes(id))) {
      errors.push({ field: 'model', message: `${modelId} 需要选择媒体协议适配器` })
    }
  }
  return errors
}

export interface LimitsValues {
  maxAgentsPerProject: number
  agentTimeoutSeconds: number
}

export function validateLimits(limits: LimitsValues): FieldError[] {
  const errors: FieldError[] = []
  if (!Number.isInteger(limits.maxAgentsPerProject) || limits.maxAgentsPerProject < 1 || limits.maxAgentsPerProject > 100) {
    errors.push({ field: 'maxAgentsPerProject', message: '范围 1-100' })
  }
  if (!Number.isInteger(limits.agentTimeoutSeconds) || limits.agentTimeoutSeconds < 10 || limits.agentTimeoutSeconds > 3600) {
    errors.push({ field: 'agentTimeoutSeconds', message: '范围 10-3600' })
  }
  return errors
}
