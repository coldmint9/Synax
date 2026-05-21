import type { PlatformRoleKey } from './contracts/team'

const EDITOR_ROLES = new Set<PlatformRoleKey>(['owner', 'admin'])
const VIEWER_ROLES = new Set<PlatformRoleKey>(['owner', 'admin', 'member', 'viewer'])

export function canViewProjectSettings(role: PlatformRoleKey | null | undefined) {
  if (!role) return false
  return VIEWER_ROLES.has(role)
}

export function canEditProjectSettings(role: PlatformRoleKey | null | undefined) {
  if (!role) return false
  return EDITOR_ROLES.has(role)
}

export function canArchiveProject(role: PlatformRoleKey | null | undefined) {
  return role === 'owner' || role === 'admin'
}

export function canTransferProject(role: PlatformRoleKey | null | undefined) {
  return role === 'owner'
}

export function canDeleteProject(role: PlatformRoleKey | null | undefined) {
  return role === 'owner'
}
