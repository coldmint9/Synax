import type { AgentProfile } from '../agent-runtime/contracts.js'
import { profileService } from '../agent-runtime/profile-service.js'

export const planGeneratorProfile: AgentProfile = {
  id: 'plan-generator',
  label: 'Plan Generator',
  kind: 'planner',
  mode: 'primary',
  description: '基于 Wiki Issues 分析代码库，生成可执行的规划节点图。',
  defaultThinkingMode: 'deep',
  allowedCapabilities: [
    'file.glob',
    'file.list',
    'file.read',
    'grep.search',
    'plan.read_source',
    'plan.read_wiki_block',
    'plan.submit_plan',
    'tools.escalate',
  ],
  permissionDefaults: [
    { gate: 'read', pattern: '*', action: 'allow', reason: 'Plan generator reads freely.' },
    { gate: 'write', pattern: '*', action: 'allow', reason: 'Plan generator submits plan.' },
    { gate: 'task', pattern: '*', action: 'deny', reason: 'Planner does not delegate.' },
    { gate: 'shell', pattern: '*', action: 'deny', reason: 'Planner does not need shell.' },
  ],
  defaultSkills: [],
  maxSteps: 200,
  status: 'active',
  toolPolicy: { allowParallelReadTools: true, allowSubtasks: false, maxParallelReadTools: 4 },
  loopHints: [
    'Read source files to understand the codebase relevant to the issues.',
    'Design plan nodes with clear dependencies and expected file changes.',
    'Call plan.submit_plan as soon as your plan is ready. Do not over-read.',
  ],
}

let registered = false
export function ensurePlanProfileRegistered(): void {
  if (registered) return
  profileService.register(planGeneratorProfile)
  registered = true
}
