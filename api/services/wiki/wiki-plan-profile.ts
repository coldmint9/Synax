import type { AgentProfile } from '../agent-runtime/contracts.js'
import { profileService } from '../agent-runtime/profile-service.js'

export const PLAN_PLANNER_PROFILE_ID = 'plan-planner'
export const PLAN_GENERATOR_LEGACY_ID = 'plan-generator'

const planPlannerBase: Omit<AgentProfile, 'id' | 'label'> = {
  kind: 'planner',
  mode: 'primary',
  description: 'Decompose user Goals into an executable Plan DAG for Goal Agent.',
  defaultThinkingMode: 'deep',
  allowedCapabilities: [
    'file.glob',
    'file.list',
    'file.read',
    'grep.search',
    'plan.read_wiki_document',
    'plan.submit_node',
    'tools.escalate',
  ],
  permissionDefaults: [
    { gate: 'read', pattern: '*', action: 'allow', reason: 'Plan planner reads freely.' },
    { gate: 'write', pattern: '*', action: 'deny', reason: 'Plan planner does not write code.' },
    { gate: 'task', pattern: '*', action: 'deny', reason: 'Planner does not delegate.' },
    { gate: 'shell', pattern: '*', action: 'deny', reason: 'Planner does not need shell.' },
  ],
  defaultSkills: [],
  maxSteps: 60,
  status: 'active',
  toolPolicy: { allowParallelReadTools: true, allowSubtasks: false, maxParallelReadTools: 4 },
  loopHints: [
    'Decompose goals into work units for Goal Agent execution.',
    'First analyze and clarify each goal before searching code.',
    'Submit each plan node with goalIds and clear acceptance criteria.',
  ],
}

export const planPlannerProfile: AgentProfile = {
  id: PLAN_PLANNER_PROFILE_ID,
  label: 'Plan Planner',
  ...planPlannerBase,
}

let registered = false

export function ensurePlanProfileRegistered(): void {
  if (registered) return
  profileService.register(planPlannerProfile)
  profileService.register({
    ...planPlannerProfile,
    id: PLAN_GENERATOR_LEGACY_ID,
    label: 'Plan Generator',
    description: 'Legacy alias for Plan Planner.',
  })
  registered = true
}
