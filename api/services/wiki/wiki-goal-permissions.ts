import type { PermissionAction } from '../agent-runtime/contracts.js'

/** Permission preset for Goal Agent executing a plan node. */
export const PLAN_NODE_PERMISSION_OVERRIDES: Record<'read' | 'write' | 'shell' | 'task', PermissionAction> = {
  read: 'allow',
  write: 'allow',
  shell: 'ask',
  task: 'allow',
}
