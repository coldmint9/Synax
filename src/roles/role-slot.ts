/**
 * Synapse Role Slot System
 *
 * Core innovation: every role is an abstract slot that can be occupied by
 * either a human or an agent, with hot-swap capability.
 *
 * Design inspired by:
 * - Claude Code's AgentDefinition + agent tool system
 * - clawspring's _BUILTIN_AGENTS with scoped tools
 * - AgentForge's RoleSlot concept
 */

import {
  type RoleSlot,
  type RoleSlotId,
  type HumanUser,
  type AgentUser,
  type ProjectId,
  RoleType,
  OccupantKind,
  SwitchPolicy,
  AgentCapabilityLevel,
  type Permission,
  PermissionMode,
} from '../models/types.js'

// ─── Role Definitions ─────────────────────────────────────────────────────

interface RoleDefinition {
  type: RoleType
  label: string
  description: string
  defaultPermissions: Permission[]
  defaultAgentPrompt: string
  defaultAgentTools: string[]
  defaultCapabilityLevel: AgentCapabilityLevel
}

const ROLE_DEFINITIONS: Record<RoleType, RoleDefinition> = {
  [RoleType.PM]: {
    type: RoleType.PM,
    label: '项目经理',
    description: '里程碑规划、资源调度、风险管控、进度汇报',
    defaultPermissions: [
      { toolName: '*', mode: PermissionMode.Default, maxCapabilityLevel: AgentCapabilityLevel.Collaborator },
    ],
    defaultAgentPrompt: `You are a Project Manager agent. Your responsibilities:
- Monitor sprint progress and identify blockers
- Generate daily progress summaries
- Suggest priority adjustments based on risk assessment
- Predict delivery delays using velocity data
- Coordinate cross-role dependencies

Always frame observations with data. Propose actions, don't just report problems.`,
    defaultAgentTools: ['TaskRead', 'TaskUpdate', 'MilestoneRead', 'SprintRead', 'WikiRead', 'WikiUpdate', 'Notify'],
    defaultCapabilityLevel: AgentCapabilityLevel.Collaborator,
  },
  [RoleType.Developer]: {
    type: RoleType.Developer,
    label: '研发工程师',
    description: '代码实现、Code Review、技术方案',
    defaultPermissions: [
      { toolName: 'Read', mode: PermissionMode.AcceptAll, maxCapabilityLevel: AgentCapabilityLevel.Autonomous },
      { toolName: 'Write', mode: PermissionMode.Default, maxCapabilityLevel: AgentCapabilityLevel.Collaborator },
      { toolName: 'Edit', mode: PermissionMode.Default, maxCapabilityLevel: AgentCapabilityLevel.Collaborator },
      { toolName: 'Bash', mode: PermissionMode.Default, maxCapabilityLevel: AgentCapabilityLevel.Executor },
    ],
    defaultAgentPrompt: `You are a Developer agent. Your responsibilities:
- Implement assigned tasks following project conventions
- Write clean, idiomatic code with minimal changes
- Run tests and fix failures
- Create PRs with clear descriptions
- Review code from other developers

Prefer editing existing files over creating new ones. Always use absolute paths.`,
    defaultAgentTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'TaskRead', 'TaskUpdate'],
    defaultCapabilityLevel: AgentCapabilityLevel.Executor,
  },
  [RoleType.QA]: {
    type: RoleType.QA,
    label: '测试工程师',
    description: '测试计划、用例编写、缺陷验证',
    defaultPermissions: [
      { toolName: 'Read', mode: PermissionMode.AcceptAll, maxCapabilityLevel: AgentCapabilityLevel.Autonomous },
      { toolName: 'Bash', mode: PermissionMode.AcceptAll, maxCapabilityLevel: AgentCapabilityLevel.Collaborator },
    ],
    defaultAgentPrompt: `You are a QA agent. Your responsibilities:
- Generate test cases from requirements and code analysis
- Execute regression tests and report results
- Analyze code coverage and suggest improvements
- Classify and prioritize bugs
- Verify fixes before merge

Focus on edge cases and error conditions. Keep tests simple and readable.`,
    defaultAgentTools: ['Read', 'Bash', 'Glob', 'Grep', 'TaskRead', 'TaskUpdate'],
    defaultCapabilityLevel: AgentCapabilityLevel.Executor,
  },
  [RoleType.Product]: {
    type: RoleType.Product,
    label: '产品经理',
    description: '需求定义、用户故事、验收标准',
    defaultPermissions: [
      { toolName: '*', mode: PermissionMode.Default, maxCapabilityLevel: AgentCapabilityLevel.Observer },
    ],
    defaultAgentPrompt: `You are a Product Manager agent. Your responsibilities:
- Draft PRDs and user stories from high-level requirements
- Analyze user feedback and categorize by theme
- Define acceptance criteria for features
- Suggest priority ordering based on business impact
- Track requirement coverage across sprints

Frame everything in terms of user value and business outcomes.`,
    defaultAgentTools: ['Read', 'TaskRead', 'TaskCreate', 'WikiRead', 'WikiUpdate', 'Notify'],
    defaultCapabilityLevel: AgentCapabilityLevel.Observer,
  },
  [RoleType.Designer]: {
    type: RoleType.Designer,
    label: '设计师',
    description: 'UI/UX 设计、交互规范、设计系统',
    defaultPermissions: [
      { toolName: 'Read', mode: PermissionMode.AcceptAll, maxCapabilityLevel: AgentCapabilityLevel.Observer },
    ],
    defaultAgentPrompt: `You are a Design agent. Your responsibilities:
- Generate wireframes and UI mockups from requirements
- Check design consistency across components
- Extract design tokens from specifications
- Suggest UX improvements based on interaction patterns

Prioritize accessibility and consistency.`,
    defaultAgentTools: ['Read', 'Glob', 'Grep', 'TaskRead', 'WikiRead'],
    defaultCapabilityLevel: AgentCapabilityLevel.Observer,
  },
  [RoleType.DevOps]: {
    type: RoleType.DevOps,
    label: '运维工程师',
    description: '部署、监控、基础设施',
    defaultPermissions: [
      { toolName: 'Bash', mode: PermissionMode.Default, maxCapabilityLevel: AgentCapabilityLevel.Collaborator },
    ],
    defaultAgentPrompt: `You are a DevOps agent. Your responsibilities:
- Manage CI/CD pipelines
- Monitor deployment health
- Respond to alerts and incidents
- Optimize infrastructure costs
- Manage environment configurations

Always verify before executing destructive operations.`,
    defaultAgentTools: ['Bash', 'Read', 'Glob', 'Grep', 'TaskRead', 'TaskUpdate'],
    defaultCapabilityLevel: AgentCapabilityLevel.Executor,
  },
}

// ─── Role Slot Manager ────────────────────────────────────────────────────

export class RoleSlotManager {
  private slots: Map<RoleSlotId, RoleSlot> = new Map()
  private switchLog: Array<{ slotId: RoleSlotId; from: string; to: string; timestamp: number; reason: string }> = []

  createSlot(projectId: ProjectId, roleType: RoleType, occupant: HumanUser | AgentUser): RoleSlot {
    const def = ROLE_DEFINITIONS[roleType]
    const slot: RoleSlot = {
      id: `role_${roleType}_${projectId}_${Date.now()}`,
      type: roleType,
      occupant,
      permissions: def.defaultPermissions,
      switchPolicy: SwitchPolicy.Hybrid,
      capabilityLevel: occupant.kind === OccupantKind.Agent
        ? (occupant as AgentUser).capabilityLevel ?? def.defaultCapabilityLevel
        : AgentCapabilityLevel.Autonomous,
      failoverTimeoutMs: 30 * 60 * 1000, // 30 minutes default
      projectId,
    }
    this.slots.set(slot.id, slot)
    return slot
  }

  getSlot(id: RoleSlotId): RoleSlot | undefined {
    return this.slots.get(id)
  }

  getSlotsByProject(projectId: ProjectId): RoleSlot[] {
    return [...this.slots.values()].filter(s => s.projectId === projectId)
  }

  getSlotByRole(projectId: ProjectId, roleType: RoleType): RoleSlot | undefined {
    return [...this.slots.values()].find(s => s.projectId === projectId && s.type === roleType)
  }

  /**
   * Hot-swap: switch a role slot's occupant between human and agent.
   * This is the core innovation — seamless switching without workflow disruption.
   */
  switchOccupant(
    slotId: RoleSlotId,
    newOccupant: HumanUser | AgentUser,
    reason: string = 'manual',
  ): RoleSlot {
    const slot = this.slots.get(slotId)
    if (!slot) throw new Error(`RoleSlot not found: ${slotId}`)

    const oldOccupantName = slot.occupant.name
    slot.occupant = newOccupant

    if (newOccupant.kind === OccupantKind.Agent) {
      slot.capabilityLevel = (newOccupant as AgentUser).capabilityLevel
    } else {
      slot.capabilityLevel = AgentCapabilityLevel.Autonomous
    }

    this.switchLog.push({
      slotId,
      from: oldOccupantName,
      to: newOccupant.name,
      timestamp: Date.now(),
      reason,
    })

    return slot
  }

  /**
   * Auto-failover: if a human occupant hasn't responded within timeout,
   * automatically switch to an agent.
   */
  async checkFailover(slotId: RoleSlotId, lastActivityTimestamp: number): Promise<RoleSlot | null> {
    const slot = this.slots.get(slotId)
    if (!slot) return null
    if (slot.switchPolicy === SwitchPolicy.Manual) return null
    if (slot.occupant.kind === OccupantKind.Agent) return null

    const elapsed = Date.now() - lastActivityTimestamp
    if (elapsed < slot.failoverTimeoutMs) return null

    const def = ROLE_DEFINITIONS[slot.type]
    const agentOccupant: AgentUser = {
      kind: OccupantKind.Agent,
      id: `auto_agent_${slot.type}`,
      name: `${def.label} Agent (Auto)`,
      model: 'default',
      systemPrompt: def.defaultAgentPrompt,
      allowedTools: def.defaultAgentTools,
      capabilityLevel: AgentCapabilityLevel.Executor, // Conservative for auto-failover
      source: 'built-in',
    }

    return this.switchOccupant(slotId, agentOccupant, 'auto_failover')
  }

  getSwitchLog(): typeof this.switchLog {
    return [...this.switchLog]
  }
}

// ─── Built-in Agent Factory ───────────────────────────────────────────────

export function createBuiltinAgent(roleType: RoleType, overrides?: Partial<AgentUser>): AgentUser {
  const def = ROLE_DEFINITIONS[roleType]
  return {
    kind: OccupantKind.Agent,
    id: `agent_${roleType}_builtin`,
    name: `${def.label} Agent`,
    model: 'default',
    systemPrompt: def.defaultAgentPrompt,
    allowedTools: def.defaultAgentTools,
    capabilityLevel: def.defaultCapabilityLevel,
    source: 'built-in',
    ...overrides,
  }
}

export function getRoleDefinition(roleType: RoleType): RoleDefinition {
  return ROLE_DEFINITIONS[roleType]
}

export function getAllRoleDefinitions(): Record<RoleType, RoleDefinition> {
  return ROLE_DEFINITIONS
}
