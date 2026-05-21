import { z } from 'zod'

export const PlatformRoleKeySchema = z.enum(['owner', 'admin', 'member', 'viewer'])
export type PlatformRoleKey = z.infer<typeof PlatformRoleKeySchema>

export const MemberStatusSchema = z.enum(['active', 'invited', 'disabled'])
export type MemberStatus = z.infer<typeof MemberStatusSchema>

export const MemberAvailabilitySchema = z.enum(['available', 'busy', 'overloaded', 'off'])
export type MemberAvailability = z.infer<typeof MemberAvailabilitySchema>

export const ExecRoleTypeSchema = z.enum(['pm', 'developer', 'qa', 'product', 'designer', 'devops'])
export type ExecRoleType = z.infer<typeof ExecRoleTypeSchema>

export const AppPlanSchema = z.enum(['personal', 'enterprise'])
export type AppPlan = z.infer<typeof AppPlanSchema>

export const PlatformRoleSchema = z.object({
  key: PlatformRoleKeySchema,
  label: z.string().min(1),
  description: z.string().min(1),
  permissions: z.array(z.string().min(1)),
})
export type PlatformRole = z.infer<typeof PlatformRoleSchema>

export const MemberSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  platformRole: PlatformRoleKeySchema,
  status: MemberStatusSchema,
  avatar: z.string().min(1),
  title: z.string().optional(),
  timezone: z.string().optional(),
})
export type Member = z.infer<typeof MemberSchema>

export const ProjectMembershipSchema = z.object({
  projectId: z.string().min(1),
  memberId: z.string().min(1),
  joinedAt: z.string().min(1),
})
export type ProjectMembership = z.infer<typeof ProjectMembershipSchema>

export const RoleSlotSchema = z.object({
  slotId: z.string().min(1),
  projectId: z.string().min(1),
  roleType: ExecRoleTypeSchema,
  roleLabel: z.string().min(1),
  memberIds: z.array(z.string().min(1)),
  agentKeys: z.array(z.string().min(1)),
  updatedAt: z.string().min(1),
})
export type RoleSlot = z.infer<typeof RoleSlotSchema>

export const PlanLimitsSchema = z.object({
  maxAgentsPerRole: z.number().int().positive(),
})
export type PlanLimits = z.infer<typeof PlanLimitsSchema>

export const MemberAssignmentSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  roleType: ExecRoleTypeSchema,
  roleLabel: z.string().min(1),
  activeTaskCount: z.number().int().nonnegative(),
})
export type MemberAssignment = z.infer<typeof MemberAssignmentSchema>

export const MemberWorkloadSchema = z.object({
  memberId: z.string().min(1),
  capacityPercent: z.number().min(0).max(200),
  weeklyCommittedHours: z.number().nonnegative(),
  weeklyCapacityHours: z.number().positive(),
  activeTaskCount: z.number().int().nonnegative(),
  blockedTaskCount: z.number().int().nonnegative(),
  reviewDebtCount: z.number().int().nonnegative(),
  availability: MemberAvailabilitySchema,
  lastActiveAt: z.string().min(1),
  assignments: z.array(MemberAssignmentSchema),
})
export type MemberWorkload = z.infer<typeof MemberWorkloadSchema>

export const PermissionSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  category: z.string().min(1),
  description: z.string().min(1),
})
export type Permission = z.infer<typeof PermissionSchema>

export const CreateMemberRequestSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  platformRole: PlatformRoleKeySchema,
})
export type CreateMemberRequest = z.infer<typeof CreateMemberRequestSchema>

export const UpdateMemberRequestSchema = z.object({
  name: z.string().min(1).optional(),
  platformRole: PlatformRoleKeySchema.optional(),
  status: MemberStatusSchema.optional(),
})
export type UpdateMemberRequest = z.infer<typeof UpdateMemberRequestSchema>

export const AssignRoleRequestSchema = z.object({
  projectId: z.string().min(1),
  roleType: ExecRoleTypeSchema,
  memberId: z.string().min(1),
})
export type AssignRoleRequest = z.infer<typeof AssignRoleRequestSchema>

export const AddAgentToRoleRequestSchema = z.object({
  projectId: z.string().min(1),
  roleType: ExecRoleTypeSchema,
  agentKey: z.string().min(1),
})
export type AddAgentToRoleRequest = z.infer<typeof AddAgentToRoleRequestSchema>

export const RemoveAgentFromRoleRequestSchema = z.object({
  projectId: z.string().min(1),
  roleType: ExecRoleTypeSchema,
  agentKey: z.string().min(1),
})
export type RemoveAgentFromRoleRequest = z.infer<typeof RemoveAgentFromRoleRequestSchema>

export const UpdatePlanRequestSchema = z.object({
  plan: AppPlanSchema,
})
export type UpdatePlanRequest = z.infer<typeof UpdatePlanRequestSchema>

export const MemberListResponseSchema = z.object({
  members: z.array(MemberSchema),
  roles: z.array(PlatformRoleSchema),
})
export type MemberListResponse = z.infer<typeof MemberListResponseSchema>

export const ProjectTeamResponseSchema = z.object({
  projectId: z.string().min(1),
  memberships: z.array(ProjectMembershipSchema),
  roleSlots: z.array(RoleSlotSchema),
  plan: AppPlanSchema,
  planLimits: PlanLimitsSchema,
})
export type ProjectTeamResponse = z.infer<typeof ProjectTeamResponseSchema>

export const TeamOverviewResponseSchema = z.object({
  members: z.array(MemberSchema),
  workloads: z.array(MemberWorkloadSchema),
  roles: z.array(PlatformRoleSchema),
  permissions: z.array(PermissionSchema),
})
export type TeamOverviewResponse = z.infer<typeof TeamOverviewResponseSchema>
