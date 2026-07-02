import type { AgentProfile } from '../agent-runtime/contracts.js'
import { profileService } from '../agent-runtime/profile-service.js'

export const refreshAgentProfile: AgentProfile = {
  id: 'wiki-refresh',
  label: 'Wiki Refresh Agent',
  kind: 'planner',
  mode: 'primary',
  description: '分析代码变更对文档的影响，生成文档更新草稿。',
  defaultThinkingMode: 'deep',
  allowedCapabilities: [
    'refresh.read_document',
    'refresh.submit_changes',
  ],
  permissionDefaults: [
    { gate: 'read', pattern: '*', action: 'allow', reason: 'Refresh agent reads freely.' },
    { gate: 'write', pattern: '*', action: 'allow', reason: 'Refresh agent submits changes.' },
    { gate: 'task', pattern: '*', action: 'deny', reason: 'Refresh agent does not delegate.' },
    { gate: 'shell', pattern: '*', action: 'deny', reason: 'Refresh agent does not need shell.' },
  ],
  maxSteps: 15,
  status: 'active',
  toolPolicy: { allowParallelReadTools: true, allowSubtasks: false, maxParallelReadTools: 4 },
  loopHints: [
    'All context you need is in the prompt. Do NOT try to explore the codebase.',
    'Use refresh.read_document if you need the full current markdown.',
    'Call refresh.submit_changes IMMEDIATELY after analyzing the provided context.',
    'If no update is needed, call refresh.submit_changes with the unchanged markdown and explain why.',
  ],
}

let registered = false
export function ensureRefreshProfileRegistered(): void {
  if (registered) return
  profileService.register(refreshAgentProfile)
  registered = true
}
