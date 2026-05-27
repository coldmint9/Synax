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
    'plan.read_wiki_block',
    'plan.submit_node',
    'tools.escalate',
  ],
  permissionDefaults: [
    { gate: 'read', pattern: '*', action: 'allow', reason: 'Plan generator reads freely.' },
    { gate: 'write', pattern: '*', action: 'allow', reason: 'Plan generator submits plan.' },
    { gate: 'task', pattern: '*', action: 'deny', reason: 'Planner does not delegate.' },
    { gate: 'shell', pattern: '*', action: 'deny', reason: 'Planner does not need shell.' },
  ],
  defaultSkills: [],
  maxSteps: 60,
  status: 'active',
  toolPolicy: { allowParallelReadTools: true, allowSubtasks: false, maxParallelReadTools: 4 },
  loopHints: [
    'IMPORTANT: First analyze and clarify each issue before searching code. Understand what each issue asks, identify ambiguities, and note dependencies between issues.',
    'Use grep.search to find relevant symbols and patterns based on the source bindings provided in the prompt. Batch multiple searches in one step.',
    'Use file.read only for targeted code snippets — never read entire files.',
    'Submit each plan node individually using plan.submit_node as soon as you design it. Submit in dependency order — nodes with no dependencies first.',
  ],
}

let registered = false
export function ensurePlanProfileRegistered(): void {
  if (registered) return
  profileService.register(planGeneratorProfile)
  registered = true
}
