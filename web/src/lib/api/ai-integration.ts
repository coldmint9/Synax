// ── DEPRECATED (2026-04-28) ───────────────────────────────────────────────
// 本文件已废弃。旧的 "AI Integration + Agent Binding" 概念已统一迁移到
// 两级配置体系（GlobalConfig + ProjectConfig）。请使用：
//   · web/src/lib/api/config.ts     — 统一配置 API
//   · web/src/lib/contracts/config.ts — 统一配置类型
//   · web/src/react/features/settings/ConfigPage.tsx — 统一配置界面
//
// 本文件保留用于向后兼容，但所有数据存储在内存中，服务器重启即丢失。
// 新代码请勿引用本文件。
// ────────────────────────────────────────────────────────────────────────────

import type {
  AgentApiBinding,
  AiIntegration,
  UpdateAiIntegrationStatusRequest,
  UpsertAgentApiBindingRequest,
  UpsertAiIntegrationRequest,
} from '../contracts/ai-integration'

const integrations: AiIntegration[] = [
  {
    id: 'ai-default',
    provider: 'openai',
    name: 'Default',
    baseUrl: 'https://api.openai.com',
    model: 'gpt-4.1',
    apiKeyMasked: 'sk-••••',
    status: 'active',
    isDefault: true,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    createdBy: 'System',
  },
]

const bindings: AgentApiBinding[] = []

export const aiIntegrationApi = {
  async list() {
    return { items: [...integrations] }
  },
  async create(_payload: UpsertAiIntegrationRequest, operator: string) {
    const id = `ai-${Date.now()}`
    const item: AiIntegration = {
      id,
      provider: _payload.provider,
      name: _payload.name,
      baseUrl: _payload.baseUrl,
      model: _payload.model,
      apiKeyMasked: '••••',
      status: 'active',
      isDefault: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: operator,
    }
    integrations.unshift(item)
    return item
  },
  async update(integrationId: string, payload: UpsertAiIntegrationRequest) {
    const i = integrations.find(x => x.id === integrationId)
    if (!i) throw new Error('integration not found')
    i.name = payload.name
    i.baseUrl = payload.baseUrl
    i.model = payload.model
    i.provider = payload.provider
    i.updatedAt = new Date().toISOString()
    return i
  },
  async updateStatus(integrationId: string, payload: UpdateAiIntegrationStatusRequest) {
    const i = integrations.find(x => x.id === integrationId)
    if (!i) throw new Error('integration not found')
    i.status = payload.status
    return i
  },
  async setDefault(integrationId: string) {
    for (const x of integrations) x.isDefault = x.id === integrationId
  },
  async remove(integrationId: string) {
    const idx = integrations.findIndex(x => x.id === integrationId)
    if (idx < 0) throw new Error('integration not found')
    integrations.splice(idx, 1)
  },
  async listBindings() {
    return { items: [...bindings] }
  },
  async upsertBinding(payload: UpsertAgentApiBindingRequest, operator: string) {
    const b: AgentApiBinding = {
      id: `bind-${Date.now()}`,
      projectId: payload.projectId,
      roleType: payload.roleType,
      agentKey: payload.agentKey,
      integrationId: payload.integrationId,
      updatedAt: new Date().toISOString(),
      updatedBy: operator,
    }
    bindings.unshift(b)
    return b
  },
  async removeBinding(bindingId: string) {
    const idx = bindings.findIndex(b => b.id === bindingId)
    if (idx >= 0) bindings.splice(idx, 1)
  },
}