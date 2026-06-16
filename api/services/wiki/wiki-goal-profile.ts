import type { AgentProfile } from '../agent-runtime/contracts.js'
import { profileService } from '../agent-runtime/profile-service.js'

export const GOAL_AGENT_PROFILE_ID = 'goal'

export const goalAgentProfile: AgentProfile = {
  id: GOAL_AGENT_PROFILE_ID,
  label: 'Goal Agent',
  kind: 'executor',
  mode: 'primary',
  description: 'General-purpose coding agent that works toward user goals in the repository.',
  defaultThinkingMode: 'standard',
  allowedCapabilities: [
    'bash',
    'file.read',
    'file.glob',
    'file.list',
    'grep.search',
    'diff.read',
    'file.write',
    'file.patch',
    'task.create',
    'task.update',
    'task.get',
    'task.list',
    'subagent.delegate',
    'skill.load',
    'tools.escalate',
  ],
  permissionDefaults: [
    { gate: 'read', pattern: '*', action: 'allow', reason: 'Goal agent reads freely.' },
    { gate: 'write', pattern: '*', action: 'ask', reason: 'Writes require approval.' },
    { gate: 'shell', pattern: '*', action: 'ask', reason: 'Shell execution requires approval.' },
    { gate: 'task', pattern: '*', action: 'ask', reason: 'Task delegation requires approval.' },
  ],
  defaultSkills: ['action-executor'],
  maxSteps: 48,
  status: 'active',
  toolPolicy: { allowParallelReadTools: true, allowSubtasks: true, maxParallelReadTools: 4 },
  loopHints: [
    'Work toward the user goal with bounded, verifiable steps.',
    'Read and search before editing. Prefer file.patch for surgical changes.',
    'When wiki context is attached, keep documentation in sync after code changes.',
  ],
  allowsSubsessions: true,
}

let registered = false

export function ensureGoalProfileRegistered(): void {
  if (registered) return
  profileService.register(goalAgentProfile)
  registered = true
}
