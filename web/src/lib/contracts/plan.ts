/** Sprint / task types kept for optional plan surfaces (no mock data in domain). */

export type TaskStatus =
  | 'ready'
  | 'in_progress'
  | 'in_review'
  | 'testing'
  | 'done'
  | 'blocked'

export type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3'

export type TaskOriginRef = { rippleClusterId: string; nodeId: string }

export interface PlanTask {
  id: string
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  type: 'feature' | 'bugfix' | 'chore' | 'improvement'
  assignee: string
  assigneeKind: 'agent' | 'human'
  sprintId: string | null
  linkedReqs: string[]
  linkedAdrs: string[]
  linkedWiki: string[]
  gitBranch: string
  origin: 'manual' | 'derived'
  originRef?: TaskOriginRef
  derivedStatus: boolean
  createdAt: string
  updatedAt: string
}

export interface PlanSprint {
  id: string
  name: string
  goal: string
  status: 'planning' | 'active' | 'completed'
  startAt: string
  endAt: string
  capacity: number
}
