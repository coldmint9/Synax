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
    'refresh.read_block',
    'refresh.submit_changes',
  ],
  permissionDefaults: [
    { gate: 'read', pattern: '*', action: 'allow', reason: 'Refresh agent reads freely.' },
    { gate: 'write', pattern: '*', action: 'allow', reason: 'Refresh agent submits changes.' },
    { gate: 'task', pattern: '*', action: 'deny', reason: 'Refresh agent does not delegate.' },
    { gate: 'shell', pattern: '*', action: 'deny', reason: 'Refresh agent does not need shell.' },
  ],
  defaultSkills: [],
  maxSteps: 15,
  status: 'active',
  toolPolicy: { allowParallelReadTools: true, allowSubtasks: false, maxParallelReadTools: 4 },
  loopHints: [
    'All context you need is in the prompt. Do NOT try to explore the codebase.',
    'Use refresh.read_block ONLY if a block content is truncated and you need the full text.',
    'Call refresh.submit_changes IMMEDIATELY after analyzing the provided context.',
    'If no blocks need updating, call refresh.submit_changes with an empty changes array.',
  ],
}

let registered = false
export function ensureRefreshProfileRegistered(): void {
  if (registered) return
  profileService.register(refreshAgentProfile)
  registered = true
}
