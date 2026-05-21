import {
  type AddAgentToRoleRequest,
  type AssignRoleRequest,
  type CreateMemberRequest,
  type Member,
  type MemberAssignment,
  type MemberListResponse,
  type MemberWorkload,
  type Permission,
  type PlatformRole,
  type ProjectMembership,
  type ProjectTeamResponse,
  type RemoveAgentFromRoleRequest,
  type RoleSlot,
  type TeamOverviewResponse,
  type UpdateMemberRequest,
  type UpdatePlanRequest,
} from '../contracts/team'

const platformRoles: PlatformRole[] = [
  { key: 'owner', label: 'Owner', description: 'Full access', permissions: ['*'] },
  { key: 'admin', label: 'Admin', description: 'Admin', permissions: ['settings', 'team'] },
  { key: 'member', label: 'Member', description: 'Member', permissions: ['project'] },
  { key: 'viewer', label: 'Viewer', description: 'Viewer', permissions: ['read'] },
]

let members: Member[] = [
  {
    id: 'u-alice',
    name: 'Alice Chen',
    email: 'alice@rumbling.local',
    platformRole: 'owner',
    status: 'active',
    avatar: 'AC',
  },
]

const permissions: Permission[] = [
  { key: 'project.view', label: 'View', category: 'project', description: 'View project' },
]

const memberships = new Map<string, ProjectMembership[]>()
const roleSlotsByProject = new Map<string, RoleSlot[]>()

function ensureProjectTeam(projectId: string): ProjectTeamResponse {
  if (!roleSlotsByProject.has(projectId)) {
    const slots: RoleSlot[] = ['pm', 'developer', 'qa', 'product', 'designer', 'devops'].map(roleType => ({
      slotId: `${projectId}-${roleType}`,
      projectId,
      roleType: roleType as RoleSlot['roleType'],
      roleLabel: roleType,
      memberIds: [],
      agentKeys: [],
      updatedAt: 'just now',
    }))
    roleSlotsByProject.set(projectId, slots)
  }
  if (!memberships.has(projectId)) {
    memberships.set(projectId, [
      { projectId, memberId: 'u-alice', joinedAt: '2026-01-01' },
    ])
  }
  return {
    projectId,
    memberships: memberships.get(projectId)!,
    roleSlots: roleSlotsByProject.get(projectId)!,
    plan: 'personal',
    planLimits: { maxAgentsPerRole: 3 },
  }
}

function workloadFor(m: Member): MemberWorkload {
  return {
    memberId: m.id,
    capacityPercent: 60,
    weeklyCommittedHours: 24,
    weeklyCapacityHours: 40,
    activeTaskCount: 2,
    blockedTaskCount: 0,
    reviewDebtCount: 0,
    availability: 'available',
    lastActiveAt: 'just now',
    assignments: [] as MemberAssignment[],
  }
}

export const teamApi = {
  async listMembersAndRoles(): Promise<MemberListResponse> {
    return { members: [...members], roles: platformRoles }
  },

  async getTeamOverview(): Promise<TeamOverviewResponse> {
    return {
      members: [...members],
      workloads: members.map(workloadFor),
      roles: platformRoles,
      permissions,
    }
  },

  async createMember(payload: CreateMemberRequest) {
    const m: Member = {
      id: `u-${Date.now()}`,
      name: payload.name,
      email: payload.email,
      platformRole: payload.platformRole,
      status: 'active',
      avatar: payload.name.slice(0, 2).toUpperCase(),
    }
    members.push(m)
    return m
  },

  async updateMember(memberId: string, payload: UpdateMemberRequest) {
    const m = members.find(x => x.id === memberId)
    if (!m) throw new Error('member not found')
    if (payload.name) m.name = payload.name
    if (payload.platformRole) m.platformRole = payload.platformRole
    if (payload.status) m.status = payload.status
    return m
  },

  async getProjectTeam(projectId: string): Promise<ProjectTeamResponse> {
    return ensureProjectTeam(projectId)
  },

  async assignProjectRole(payload: AssignRoleRequest) {
    const team = ensureProjectTeam(payload.projectId)
    const slot = team.roleSlots.find(s => s.roleType === payload.roleType)
    if (!slot) throw new Error('slot not found')
    slot.memberIds = [payload.memberId]
    slot.updatedAt = 'just now'
  },

  async addAgentToRole(payload: AddAgentToRoleRequest) {
    const team = ensureProjectTeam(payload.projectId)
    const slot = team.roleSlots.find(s => s.roleType === payload.roleType)
    if (!slot) throw new Error('slot not found')
    if (!slot.agentKeys.includes(payload.agentKey)) {
      slot.agentKeys = [...slot.agentKeys, payload.agentKey]
    }
    slot.updatedAt = 'just now'
  },

  async removeAgentFromRole(payload: RemoveAgentFromRoleRequest) {
    const team = ensureProjectTeam(payload.projectId)
    const slot = team.roleSlots.find(s => s.roleType === payload.roleType)
    if (!slot) throw new Error('slot not found')
    slot.agentKeys = slot.agentKeys.filter(k => k !== payload.agentKey)
    slot.updatedAt = 'just now'
  },

  async updatePlan(_payload: UpdatePlanRequest) {
    // no-op: plan stored server-side in full product
  },

  async getMemberProjects(_memberId: string) {
    return [
      { projectId: 'rumbling-core', name: 'Rumbling Core' },
      { projectId: 'growth-ops', name: 'Growth Ops' },
      { projectId: 'mobile-revamp', name: 'Mobile Revamp' },
    ]
  },
}
