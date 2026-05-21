/**
 * PM Taxonomy — Verdict / Artifact / Operation vocabulary
 *
 * Single source of truth for all PM-level concepts used in ripples.
 * Each entry carries label, accent color token, and icon name (lucide).
 */

// ─── Verdict (PM classification of intent) ────────────────────────────────

export type PmVerdict =
  | 'incremental_adjust'
  | 'new_requirement'
  | 'risk_escalation'
  | 'scope_change'
  | 'tech_debt'
  | 'bug_fix'
  | 'knowledge_update'
  | 'team_orchestration'
  | 'forecast_query'
  | 'decision_request'

export interface VerdictConfig {
  type: PmVerdict
  label: string
  shortLabel: string
  description: string
  accentVar: string   // CSS variable name, e.g. 'verdict-bug'
  icon: string        // lucide icon name
  aiPersona: string   // The AI identity used in node chat
}

export const VERDICT_CONFIGS: VerdictConfig[] = [
  {
    type: 'incremental_adjust',
    label: '意图澄清',
    shortLabel: 'CLARIFY',
    description: '补充或修正既有 Intent 的边界',
    accentVar: 'verdict-adjust',
    icon: 'SlidersHorizontal',
    aiPersona: 'Intent Curator',
  },
  {
    type: 'new_requirement',
    label: '新意图',
    shortLabel: 'NEW-INTENT',
    description: '识别并创建新的目标方向',
    accentVar: 'verdict-new-req',
    icon: 'Sparkles',
    aiPersona: 'Intent Curator',
  },
  {
    type: 'risk_escalation',
    label: '风险信号',
    shortLabel: 'RISK',
    description: '现实出现阻塞或质量下滑，需要关注',
    accentVar: 'verdict-risk',
    icon: 'AlertTriangle',
    aiPersona: 'Reality Analyst',
  },
  {
    type: 'scope_change',
    label: '范围漂移',
    shortLabel: 'DRIFT',
    description: 'Reality 与 Intent 范围出现偏移',
    accentVar: 'verdict-scope',
    icon: 'GitBranch',
    aiPersona: 'Reality Analyst',
  },
  {
    type: 'tech_debt',
    label: '结构负担',
    shortLabel: 'DEBT',
    description: '当前实现与长期约束不一致',
    accentVar: 'verdict-debt',
    icon: 'Wrench',
    aiPersona: 'Memory Keeper',
  },
  {
    type: 'bug_fix',
    label: '稳定性缺口',
    shortLabel: 'STABILITY',
    description: '已观测到故障或失败回归',
    accentVar: 'verdict-bug',
    icon: 'Bug',
    aiPersona: 'Reality Analyst',
  },
  {
    type: 'knowledge_update',
    label: '认知更新',
    shortLabel: 'KNOW',
    description: '需要把新结论沉淀到 Memory',
    accentVar: 'verdict-knowledge',
    icon: 'BookOpen',
    aiPersona: 'Memory Keeper',
  },
  {
    type: 'team_orchestration',
    label: '关注编排',
    shortLabel: 'ATTN',
    description: '需要人类明确接管或确认',
    accentVar: 'verdict-team',
    icon: 'Users',
    aiPersona: 'Attention Guide',
  },
  {
    type: 'forecast_query',
    label: '影响预测',
    shortLabel: 'FORECAST',
    description: '对意图推进节奏的预估分析',
    accentVar: 'verdict-forecast',
    icon: 'TrendingUp',
    aiPersona: 'Reality Analyst',
  },
  {
    type: 'decision_request',
    label: '需要裁决',
    shortLabel: 'DECIDE',
    description: '进入人类裁决环节，决定是否接受现实',
    accentVar: 'verdict-decision',
    icon: 'Scale',
    aiPersona: 'Decision Desk',
  },
]

export function getVerdictConfig(type: PmVerdict): VerdictConfig {
  return VERDICT_CONFIGS.find(v => v.type === type) ?? VERDICT_CONFIGS[0]
}

// ─── Artifact Types ────────────────────────────────────────────────────────

export type ArtifactType =
  | 'epic'
  | 'requirement'
  | 'milestone'
  | 'sprint'
  | 'backlog_item'
  | 'task'
  | 'subtask'
  | 'adr'
  | 'wiki'
  | 'risk'

export interface ArtifactConfig {
  type: ArtifactType
  label: string
  shortLabel: string
  icon: string
  accentVar: string
  aiPersona: string   // The AI identity used when chatting on this artifact node
}

export const ARTIFACT_CONFIGS: ArtifactConfig[] = [
  { type: 'epic',         label: 'Intent',        shortLabel: 'INTENT',   icon: 'Layers',       accentVar: 'artifact-epic',     aiPersona: 'Intent Curator' },
  { type: 'requirement',  label: 'Constraint',    shortLabel: 'RULE',     icon: 'FileText',     accentVar: 'artifact-req',      aiPersona: 'Memory Keeper' },
  { type: 'milestone',    label: 'Milestone',     shortLabel: 'MILE',     icon: 'Flag',         accentVar: 'artifact-milestone', aiPersona: 'Reality Analyst' },
  { type: 'sprint',       label: 'Attention Slot', shortLabel: 'SLOT',    icon: 'Zap',          accentVar: 'artifact-sprint',   aiPersona: 'Attention Guide' },
  { type: 'backlog_item', label: 'Opportunity',   shortLabel: 'OPP',      icon: 'List',         accentVar: 'artifact-backlog',  aiPersona: 'Intent Curator' },
  { type: 'task',         label: 'Signal',        shortLabel: 'SIGNAL',   icon: 'CheckSquare',  accentVar: 'artifact-task',     aiPersona: 'Reality Analyst' },
  { type: 'subtask',      label: 'Sub Signal',    shortLabel: 'SUB',      icon: 'CornerDownRight', accentVar: 'artifact-subtask', aiPersona: 'Reality Analyst' },
  { type: 'adr',          label: 'Decision',      shortLabel: 'DECISION', icon: 'Scale',        accentVar: 'artifact-adr',      aiPersona: 'Decision Desk' },
  { type: 'wiki',         label: 'Memory Note',   shortLabel: 'MEMO',     icon: 'BookOpen',     accentVar: 'artifact-wiki',     aiPersona: 'Memory Keeper' },
  { type: 'risk',         label: 'Risk',          shortLabel: 'RISK',     icon: 'AlertTriangle', accentVar: 'artifact-risk',     aiPersona: 'Reality Analyst' },
]

export function getArtifactConfig(type: ArtifactType): ArtifactConfig {
  return ARTIFACT_CONFIGS.find(a => a.type === type) ?? ARTIFACT_CONFIGS[5]
}

// ─── Operations ────────────────────────────────────────────────────────────

export type ArtifactOp =
  | 'create'
  | 'modify'
  | 'reprioritize'
  | 'reschedule'
  | 'reassign'
  | 'split'
  | 'merge'
  | 'defer'
  | 'cancel'
  | 'link'
  | 'block'
  | 'unblock'

export interface OpConfig {
  op: ArtifactOp
  label: string
  shortLabel: string
  verb: string       // past tense, e.g. "Created"
  accentVar: string
}

export const OP_CONFIGS: OpConfig[] = [
  { op: 'create',      label: '记录',     shortLabel: 'LOG',        verb: 'Logged',      accentVar: 'op-create' },
  { op: 'modify',      label: '修订',     shortLabel: 'REVISE',     verb: 'Revised',     accentVar: 'op-modify' },
  { op: 'reprioritize', label: '重排关注', shortLabel: 'FOCUS',     verb: 'Refocused',   accentVar: 'op-repri' },
  { op: 'reschedule',  label: '改节奏',   shortLabel: 'PACE',       verb: 'Rescheduled', accentVar: 'op-resched' },
  { op: 'reassign',    label: '转交',     shortLabel: 'HANDOFF',    verb: 'Handed off',  accentVar: 'op-reassign' },
  { op: 'split',       label: '拆分',     shortLabel: 'SPLIT',      verb: 'Split',       accentVar: 'op-split' },
  { op: 'merge',       label: '合并',     shortLabel: 'MERGE',      verb: 'Merged',      accentVar: 'op-merge' },
  { op: 'defer',       label: '延后',     shortLabel: 'DEFER',      verb: 'Deferred',    accentVar: 'op-defer' },
  { op: 'cancel',      label: '终止',     shortLabel: 'STOP',       verb: 'Stopped',     accentVar: 'op-cancel' },
  { op: 'link',        label: '关联',     shortLabel: 'LINK',       verb: 'Linked',      accentVar: 'op-link' },
  { op: 'block',       label: '标记阻塞', shortLabel: 'BLOCK',      verb: 'Blocked',     accentVar: 'op-block' },
  { op: 'unblock',     label: '解除阻塞', shortLabel: 'UNBLOCK',    verb: 'Unblocked',   accentVar: 'op-unblock' },
]

export function getOpConfig(op: ArtifactOp): OpConfig {
  return OP_CONFIGS.find(o => o.op === op) ?? OP_CONFIGS[0]
}

// ─── Execution Role Types ──────────────────────────────────────────────────

export type ExecRoleType =
  | 'pm'
  | 'developer'
  | 'qa'
  | 'product'
  | 'designer'
  | 'devops'
  | 'architect'

export interface ExecRoleConfig {
  roleType: ExecRoleType
  label: string
  shortLabel: string
  accentVar: string
  aiPersona: string
}

export const EXEC_ROLE_CONFIGS: ExecRoleConfig[] = [
  { roleType: 'pm',        label: '裁决人',      shortLabel: 'DECIDE', accentVar: 'role-pm',     aiPersona: 'Decision Desk' },
  { roleType: 'developer', label: '实现负责人',  shortLabel: 'BUILD',  accentVar: 'role-dev',    aiPersona: 'Reality Analyst' },
  { roleType: 'qa',        label: '验证负责人',  shortLabel: 'VERIFY', accentVar: 'role-qa',     aiPersona: 'Reality Analyst' },
  { roleType: 'product',   label: '意图负责人',  shortLabel: 'INTENT', accentVar: 'role-product', aiPersona: 'Intent Curator' },
  { roleType: 'designer',  label: '体验负责人',  shortLabel: 'UX',     accentVar: 'role-design', aiPersona: 'Intent Curator' },
  { roleType: 'devops',    label: '稳定性负责人', shortLabel: 'STAB',  accentVar: 'role-devops', aiPersona: 'Reality Analyst' },
  { roleType: 'architect', label: '约束负责人',  shortLabel: 'ARCH',   accentVar: 'role-arch',   aiPersona: 'Memory Keeper' },
]

export function getExecRoleConfig(roleType: ExecRoleType): ExecRoleConfig {
  return EXEC_ROLE_CONFIGS.find(r => r.roleType === roleType) ?? EXEC_ROLE_CONFIGS[0]
}

// ─── Node Status ───────────────────────────────────────────────────────────

export type NodeStatus = 'pending' | 'active' | 'completed' | 'failed' | 'skipped'

export const STATUS_LABELS: Record<NodeStatus, string> = {
  pending:   '等待',
  active:    '执行中',
  completed: '已完成',
  failed:    '失败',
  skipped:   '已跳过',
}
