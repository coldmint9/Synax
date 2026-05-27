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
    'file.read',
    'grep.search',
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
  maxSteps: 30,
  status: 'active',
  toolPolicy: { allowParallelReadTools: true, allowSubtasks: false, maxParallelReadTools: 4 },
  loopHints: [
    'Read affected blocks first to understand current content and format.',
    'Use grep.search or file.read to check actual source code changes when needed.',
    'Call refresh.submit_changes once with ALL changes. Do not call it multiple times.',
    'If no blocks need updating, call refresh.submit_changes with an empty changes array.',
  ],
}

let registered = false
export function ensureRefreshProfileRegistered(): void {
  if (registered) return
  profileService.register(refreshAgentProfile)
  registered = true
}
