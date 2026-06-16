export const GOAL_PLAN_PROFILE_ID = 'plan-generator'

export const GOAL_PERMISSION_GATES = ['read', 'write', 'shell', 'task'] as const

export type GoalPermissionGate = (typeof GOAL_PERMISSION_GATES)[number]

export type GoalPermissionAction = 'allow' | 'ask' | 'deny'

export const GOAL_PERMISSION_DEFAULTS: Record<GoalPermissionGate, GoalPermissionAction> = {
  read: 'allow',
  write: 'allow',
  shell: 'deny',
  task: 'deny',
}

export function hasGoalPermissionOverrides(
  permissions: Partial<Record<GoalPermissionGate, GoalPermissionAction>> | null,
): boolean {
  if (!permissions) return false
  return GOAL_PERMISSION_GATES.some(
    gate => permissions[gate] !== undefined && permissions[gate] !== GOAL_PERMISSION_DEFAULTS[gate],
  )
}
