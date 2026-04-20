/**
 * Requirements Page — Product requirements with traceability
 *
 * Every requirement traces to ADRs, tasks, wiki pages, and code.
 * The Product Agent auto-generates acceptance criteria and suggests
 * priorities based on user feedback analysis.
 */

import { useState } from 'react'
import { cn } from '../lib/utils'
import {
  FileText, Plus, Bot, Link2, ChevronRight,
  AlertCircle, AlertTriangle, CheckCircle2, Circle, Clock, ArrowRight,
  Filter,
} from 'lucide-react'

interface Requirement {
  id: string
  title: string
  priority: 'P0' | 'P1' | 'P2' | 'P3'
  status: 'draft' | 'defined' | 'in_progress' | 'verified' | 'released'
  type: 'feature' | 'bugfix' | 'improvement' | 'infrastructure'
  author: string
  authorKind: 'agent' | 'human'
  description: string
  userStory: string
  acceptanceCriteria: string[]
  linkedAdrs: string[]
  linkedTasks: string[]
  linkedWiki: string[]
  feedbackCount: number
  agentNote?: string
}

const REQUIREMENTS: Requirement[] = [
  {
    id: 'REQ-001', title: '项目管理仪表盘', priority: 'P0', status: 'released',
    type: 'feature', author: 'Product Agent', authorKind: 'agent',
    description: '提供项目整体视图，包含角色状态、任务进度、里程碑和事件流。',
    userStory: '作为项目经理，我希望在仪表盘上看到项目全貌，以便快速发现和解决问题。',
    acceptanceCriteria: [
      '仪表盘显示所有角色及其当前状态（Human/Agent）',
      '任务进度条实时更新，数据来源于 Git 活动',
      '事件流展示最近50个事件，支持按角色过滤',
      '里程碑显示进度百分比和风险等级',
    ],
    linkedAdrs: ['ADR-001', 'ADR-002'], linkedTasks: ['T1', 'T2'], linkedWiki: ['w1'],
    feedbackCount: 3,
  },
  {
    id: 'REQ-002', title: 'Human-Agent 角色热切换', priority: 'P0', status: 'verified',
    type: 'feature', author: 'Alice', authorKind: 'human',
    description: '任何角色槽位可以在人类和 Agent 之间无缝切换，支持手动、自动降级和混合策略。',
    userStory: '作为团队负责人，我希望在成员休假时可以让 Agent 自动接管其角色，确保项目不中断。',
    acceptanceCriteria: [
      '角色切换在一键内完成，不丢失上下文',
      '自动降级在超时30分钟后触发',
      '切换操作记入审计日志',
      'Agent 接管后从 Observer 级别开始，逐步提升',
    ],
    linkedAdrs: [], linkedTasks: ['T3'], linkedWiki: ['w1'],
    feedbackCount: 5,
  },
  {
    id: 'REQ-003', title: '用户权限管理', priority: 'P1', status: 'in_progress',
    type: 'feature', author: 'Product Agent', authorKind: 'agent',
    description: '实现用户认证、授权和会话管理，支持多角色权限体系。',
    userStory: '作为管理员，我希望不同角色有不同权限，以确保安全和责任分明。',
    acceptanceCriteria: [
      '支持 JWT Token 认证和刷新机制',
      '角色权限矩阵：PM/Dev/QA/Product/Designer/DevOps 各有不同的工具访问权限',
      '权限变更需要审计日志记录',
    ],
    linkedAdrs: ['ADR-005'], linkedTasks: ['T5', 'T8'], linkedWiki: ['w2'],
    feedbackCount: 8,
    agentNote: '⚠️ ADR-005 记录的 Session 方案与实际 JWT 实现不一致，需要决策：更新 ADR 还是修改代码？',
  },
  {
    id: 'REQ-004', title: '上下文自动压缩', priority: 'P1', status: 'verified',
    type: 'infrastructure', author: 'Wiki Agent', authorKind: 'agent',
    description: '当对话上下文接近窗口限制时，自动压缩历史消息，保留关键决策和上下文。',
    userStory: '作为 Agent，我希望在长时间工作中不会因为上下文溢出而丢失重要信息。',
    acceptanceCriteria: [
      '上下文使用超过 70% 时自动触发压缩',
      '先截断旧工具结果，再用 LLM 摘要压缩',
      '压缩后保留最近 30% 的对话完整内容',
    ],
    linkedAdrs: [], linkedTasks: ['T6'], linkedWiki: ['w1'],
    feedbackCount: 1,
  },
  {
    id: 'REQ-005', title: 'MCP 协议集成', priority: 'P2', status: 'defined',
    type: 'infrastructure', author: 'Alice', authorKind: 'human',
    description: '通过 MCP 协议让外部 Agent 接入 Synapse 工具系统。',
    userStory: '作为开发者，我希望使用 Cursor/Devin 等 IDE Agent 直接操作项目任务。',
    acceptanceCriteria: [
      '暴露 TaskRead/TaskUpdate 工具为 MCP Server',
      '支持外部 Agent 认证和权限控制',
    ],
    linkedAdrs: ['ADR-004'], linkedTasks: [], linkedWiki: [],
    feedbackCount: 2,
  },
  {
    id: 'REQ-006', title: 'CI/CD 自动部署', priority: 'P2', status: 'released',
    type: 'infrastructure', author: 'DevOps Agent', authorKind: 'agent',
    description: '实现自动化部署流水线，staging 自动部署，production 需审批。',
    userStory: '作为运维，我希望代码合并后自动部署到 staging，降低手动操作风险。',
    acceptanceCriteria: [
      'PR 合并后自动触发 staging 部署',
      'Production 部署需要人工审批',
      '部署失败自动回滚',
    ],
    linkedAdrs: ['ADR-003'], linkedTasks: ['T10'], linkedWiki: ['w3'],
    feedbackCount: 0,
  },
  {
    id: 'REQ-007', title: '项目 Wiki 自动同步', priority: 'P1', status: 'in_progress',
    type: 'feature', author: 'Product Agent', authorKind: 'agent',
    description: 'Wiki 页面从 PR、ADR、任务活动中自动生成和更新。',
    userStory: '作为新成员，我希望项目文档始终是最新的，不需要人工维护。',
    acceptanceCriteria: [
      'PR 合并后自动提取变更摘要到相关 Wiki 页面',
      'ADR 变更后自动更新架构文档',
      '过时文档自动标记 "Needs Update"',
    ],
    linkedAdrs: [], linkedTasks: ['T7'], linkedWiki: ['w2', 'w5'],
    feedbackCount: 12,
    agentNote: '📢 客户反馈量增加 200%，建议将优先级从 P2 提升至 P1。',
  },
]

const PRIORITY_STYLES: Record<string, { color: string; bg: string }> = {
  P0: { color: 'text-destructive', bg: 'bg-destructive/10' },
  P1: { color: 'text-warning', bg: 'bg-warning/10' },
  P2: { color: 'text-primary', bg: 'bg-primary/10' },
  P3: { color: 'text-muted-foreground', bg: 'bg-muted' },
}

const STATUS_ICONS: Record<string, React.ReactNode> = {
  draft: <Circle size={10} className="text-muted-foreground" />,
  defined: <Clock size={10} className="text-primary" />,
  in_progress: <AlertCircle size={10} className="text-warning" />,
  verified: <CheckCircle2 size={10} className="text-success" />,
  released: <CheckCircle2 size={10} className="text-agent" />,
}

export function RequirementsPage() {
  const [selectedReq, setSelectedReq] = useState<Requirement | null>(REQUIREMENTS[2]) // Default to REQ-003
  const [priorityFilter, setPriorityFilter] = useState<string>('all')

  const filteredReqs = REQUIREMENTS.filter(r =>
    priorityFilter === 'all' || r.priority === priorityFilter
  )

  return (
    <div className="flex h-full">
      {/* Left Panel: Requirements list */}
      <div className="w-80 flex-shrink-0 border-r border-border flex flex-col">
        <div className="h-11 flex items-center gap-2 px-4 border-b border-border">
          <FileText size={14} className="text-req" />
          <span className="text-xs font-medium">Requirements</span>
          <button className="ml-auto w-6 h-6 rounded flex items-center justify-center hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
            <Plus size={12} />
          </button>
        </div>

        {/* Priority filter */}
        <div className="px-3 py-2 flex gap-1 border-b border-border">
          {['all', 'P0', 'P1', 'P2', 'P3'].map(p => (
            <button
              key={p}
              onClick={() => setPriorityFilter(p)}
              className={cn(
                'text-[10px] font-mono px-2 py-1 rounded transition-colors',
                priorityFilter === p
                  ? p === 'all' ? 'bg-primary text-primary-foreground' : cn(PRIORITY_STYLES[p]?.bg, PRIORITY_STYLES[p]?.color)
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {p === 'all' ? 'ALL' : p}
            </button>
          ))}
        </div>

        {/* List */}
        <div className="flex-1 overflow-auto py-1">
          {filteredReqs.map(req => (
            <button
              key={req.id}
              onClick={() => setSelectedReq(req)}
              className={cn(
                'w-full text-left px-4 py-3 hover:bg-secondary transition-colors',
                selectedReq?.id === req.id && 'bg-req/5 border-l-2 border-l-req',
              )}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-mono text-req">{req.id}</span>
                  <span className={cn('text-[9px] font-mono px-1.5 py-0.5 rounded', PRIORITY_STYLES[req.priority].bg, PRIORITY_STYLES[req.priority].color)}>
                    {req.priority}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {STATUS_ICONS[req.status]}
                  {req.agentNote && <AlertTriangle size={9} className="text-warning" />}
                  {req.feedbackCount > 5 && (
                    <span className="text-[8px] font-mono px-1 py-0.5 rounded bg-req/10 text-req">🔥{req.feedbackCount}</span>
                  )}
                </div>
              </div>
              <div className="text-xs leading-snug">{req.title}</div>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[9px] font-mono text-muted-foreground">{req.type}</span>
                <span className={cn(
                  'text-[8px]',
                  req.authorKind === 'agent' ? 'text-agent' : 'text-human',
                )}>
                  by {req.author}
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Right Panel: Requirement Detail */}
      {selectedReq ? (
        <div className="flex-1 overflow-auto">
          <div className="max-w-3xl mx-auto px-8 py-8">
            {/* Header */}
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-mono text-req">{selectedReq.id}</span>
              <span className={cn('text-[10px] font-mono px-2 py-0.5 rounded', PRIORITY_STYLES[selectedReq.priority].bg, PRIORITY_STYLES[selectedReq.priority].color)}>
                {selectedReq.priority}
              </span>
              <span className="text-[10px] font-mono text-muted-foreground">{selectedReq.type}</span>
            </div>
            <h1 className="text-lg font-semibold mb-4">{selectedReq.title}</h1>

            {/* Agent Note */}
            {selectedReq.agentNote && (
              <div className="mb-6 px-4 py-3 rounded-lg bg-agent/[0.03] border border-agent/10">
                <div className="flex items-center gap-2 mb-1.5">
                  <Bot size={14} className="text-agent" />
                  <span className="text-xs font-medium text-agent">Agent Insight</span>
                </div>
                <p className="text-xs text-foreground/80 leading-relaxed">{selectedReq.agentNote}</p>
              </div>
            )}

            {/* User Story */}
            <div className="mb-6">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">User Story</div>
              <div className="px-4 py-3 rounded-lg bg-secondary text-sm leading-relaxed italic">
                {selectedReq.userStory}
              </div>
            </div>

            {/* Description */}
            <div className="mb-6">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">Description</div>
              <p className="text-sm leading-relaxed">{selectedReq.description}</p>
            </div>

            {/* Acceptance Criteria */}
            <div className="mb-6">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">Acceptance Criteria</div>
              <div className="space-y-1.5">
                {selectedReq.acceptanceCriteria.map((ac, i) => (
                  <div key={i} className="flex items-start gap-2 px-3 py-2 rounded-md bg-secondary">
                    <span className="text-[10px] font-mono text-muted-foreground mt-0.5">AC-{i + 1}</span>
                    <span className="text-xs leading-relaxed">{ac}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Trace Links */}
            <div className="mb-6">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">Traceability</div>
              <div className="space-y-3">
                {/* ADR chain */}
                {selectedReq.linkedAdrs.length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-muted-foreground w-16">ADR</span>
                    <div className="flex items-center gap-1.5">
                      {selectedReq.linkedAdrs.map(adr => (
                        <span key={adr} className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded bg-arch/10 text-arch">
                          <Link2 size={9} /> {adr}
                        </span>
                      ))}
                      <ArrowRight size={10} className="text-muted-foreground" />
                    </div>
                  </div>
                )}
                {/* Task chain */}
                {selectedReq.linkedTasks.length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-muted-foreground w-16">Tasks</span>
                    <div className="flex items-center gap-1.5">
                      {selectedReq.linkedTasks.map(t => (
                        <span key={t} className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded bg-primary/10 text-primary">
                          <Link2 size={9} /> {t}
                        </span>
                      ))}
                      <ArrowRight size={10} className="text-muted-foreground" />
                    </div>
                  </div>
                )}
                {/* Wiki chain */}
                {selectedReq.linkedWiki.length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-muted-foreground w-16">Wiki</span>
                    <div className="flex items-center gap-1.5">
                      {selectedReq.linkedWiki.map(w => (
                        <span key={w} className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded bg-wiki/10 text-wiki">
                          <Link2 size={9} /> {w}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Feedback */}
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
                Feedback ({selectedReq.feedbackCount})
              </div>
              <div className="px-4 py-3 rounded-lg border border-border bg-card">
                <div className="text-xs text-muted-foreground">
                  {selectedReq.feedbackCount > 0
                    ? `${selectedReq.feedbackCount} feedback items collected. Ask Product Agent to analyze and summarize.`
                    : 'No feedback collected yet.'
                  }
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          Select a requirement to view details
        </div>
      )}
    </div>
  )
}
