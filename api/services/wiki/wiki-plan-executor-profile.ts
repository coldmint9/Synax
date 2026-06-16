import type { AgentProfile } from '../agent-runtime/contracts.js'
import { profileService } from '../agent-runtime/profile-service.js'

export const planExecutorProfile: AgentProfile = {
  id: 'plan-executor',
  label: 'Plan Executor',
  kind: 'executor',
  mode: 'primary',
  description: 'Execute a single plan node: read code, apply patches, land Goal changes.',
  defaultThinkingMode: 'standard',
  allowedCapabilities: [
    'file.glob',
    'file.list',
    'file.read',
    'file.write',
    'file.patch',
    'grep.search',
    'diff.read',
    'tools.escalate',
  ],
  permissionDefaults: [
    { gate: 'read', pattern: '*', action: 'allow', reason: 'Executor reads freely.' },
    { gate: 'write', pattern: '*', action: 'allow', reason: 'Executor writes within plan scope.' },
    { gate: 'task', pattern: '*', action: 'deny', reason: 'Executor does not delegate.' },
    { gate: 'shell', pattern: '*', action: 'deny', reason: 'Executor uses file tools only.' },
  ],
  defaultSkills: [],
  maxSteps: 40,
  status: 'active',
  toolPolicy: { allowParallelReadTools: true, allowSubtasks: false, maxParallelReadTools: 4 },
  loopHints: [
    'Implement the plan node description. Use file.patch for edits.',
    'Read before write. Verify expected files match your changes.',
  ],
}

let registered = false
export function ensurePlanExecutorProfileRegistered(): void {
  if (registered) return
  profileService.register(planExecutorProfile)
  registered = true
}
