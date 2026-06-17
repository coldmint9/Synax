export const GOAL_PROFILE_ID = 'goal'

export type GoalWikiAttachMode = 'auto' | 'manual'

export const GOAL_PERMISSION_GATES = ['read', 'write', 'shell', 'task'] as const

export type GoalPermissionGate = (typeof GOAL_PERMISSION_GATES)[number]

export type GoalPermissionAction = 'allow' | 'ask' | 'deny'

export const GOAL_PERMISSION_DEFAULTS: Record<GoalPermissionGate, GoalPermissionAction> = {
  read: 'allow',
  write: 'ask',
  shell: 'ask',
  task: 'ask',
}

export type GoalPermissionPreset = 'standard' | 'autonomous'

export const GOAL_PERMISSION_PRESETS: Record<
  GoalPermissionPreset,
  Record<GoalPermissionGate, GoalPermissionAction>
> = {
  standard: GOAL_PERMISSION_DEFAULTS,
  autonomous: {
    read: 'allow',
    write: 'allow',
    shell: 'allow',
    task: 'ask',
  },
}

export function getGoalPermissionPreset(
  permissions: Partial<Record<GoalPermissionGate, GoalPermissionAction>> | null,
): GoalPermissionPreset {
  if (permissions?.write === 'allow' && permissions?.shell === 'allow') return 'autonomous'
  return 'standard'
}

export function goalPermissionsForPreset(
  preset: GoalPermissionPreset,
): Partial<Record<GoalPermissionGate, GoalPermissionAction>> | null {
  if (preset === 'standard') return null
  return { ...GOAL_PERMISSION_PRESETS.autonomous }
}

export function hasGoalPermissionOverrides(
  permissions: Partial<Record<GoalPermissionGate, GoalPermissionAction>> | null,
): boolean {
  if (!permissions) return false
  return GOAL_PERMISSION_GATES.some(
    gate => permissions[gate] !== undefined && permissions[gate] !== GOAL_PERMISSION_DEFAULTS[gate],
  )
}

export function toPermissionOverrides(
  permissions: Partial<Record<GoalPermissionGate, GoalPermissionAction>> | null,
): Partial<Record<GoalPermissionGate, GoalPermissionAction>> | undefined {
  if (!permissions) return undefined
  const entries = GOAL_PERMISSION_GATES
    .filter(gate => permissions[gate] !== undefined && permissions[gate] !== GOAL_PERMISSION_DEFAULTS[gate])
    .map(gate => [gate, permissions[gate]!] as const)
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries)
}
