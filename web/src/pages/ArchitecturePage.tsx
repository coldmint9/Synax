/**
 * Architecture Page — System design, ADRs, tech stack, component diagrams
 *
 * The architecture module makes invisible decisions visible.
 * Every ADR is linked to the requirement that drove it and the tasks that
 * implement it.
 */

import { useState } from 'react'
import { cn } from '../lib/utils'
import {
  Layers, Plus, GitBranch, CheckCircle2, AlertTriangle,
  Clock, Link2, ChevronRight, Bot, ArrowRight,
} from 'lucide-react'

interface ADR {
  id: string
  title: string
  status: 'proposed' | 'accepted' | 'deprecated' | 'superseded'
  date: string
  context: string
  decision: string
  consequences: string
  linkedReqs: string[]
  linkedTasks: string[]
  mismatchDetected?: boolean
  mismatchDetail?: string
}

interface TechComponent {
  name: string
  layer: 'frontend' | 'backend' | 'data' | 'agent' | 'integration'
  tech: string
  status: 'active' | 'planned' | 'deprecated'
  adrRef?: string
}

const ADRS: ADR[] = [
  {
    id: 'ADR-001', title: 'Frontend Framework: React + Vite', status: 'accepted',
    date: '2026-03-15',
    context: '需要选择前端框架来构建项目管理界面，要求实时更新和组件化开发。',
    decision: '采用 React 18 + Vite + Tailwind CSS 技术栈。React 生态成熟，Vite 开发体验优秀。',
    consequences: '优势：丰富的组件库、快速HMR。风险：React 18 的 concurrent 模式可能引入微妙 bug。',
    linkedReqs: ['REQ-001'], linkedTasks: ['T1'],
  },
  {
    id: 'ADR-002', title: 'Database: SQLite + Drizzle ORM', status: 'accepted',
    date: '2026-03-16',
    context: '项目需要持久化存储，但初期不需要分布式数据库。',
    decision: '使用 SQLite 作为单文件数据库 + Drizzle ORM 作为查询构建器，后续可迁移到 PostgreSQL。',
    linkedReqs: ['REQ-001'], linkedTasks: ['T2'],
  },
  {
    id: 'ADR-003', title: 'Deployment: Docker + GitHub Actions', status: 'accepted',
    date: '2026-03-20',
    context: '需要自动化部署流水线。',
    decision: 'Docker 容器化 + GitHub Actions CI/CD，staging 自动部署，production 手动审批。',
    linkedReqs: ['REQ-006'], linkedTasks: ['T10'],
  },
  {
    id: 'ADR-004', title: 'Agent Protocol: MCP + A2A', status: 'proposed',
    date: '2026-04-10',
    context: 'Agent 需要与外部工具和其他 Agent 通信。',
    decision: 'MCP 用于工具接入，A2A 用于 Agent 间通信。',
    consequences: '优势：开放标准。风险：A2A 协议尚在演进中。',
    linkedReqs: ['REQ-005'], linkedTasks: [],
  },
  {
    id: 'ADR-005', title: '认证方案: Session-based Auth', status: 'accepted',
    date: '2026-03-25',
    context: '需要用户认证和会话管理方案。',
    decision: '采用 Session-based 认证，服务端存储会话，Cookie 传递 Session ID。',
    consequences: '优势：简单安全。劣势：不易横向扩展。',
    linkedReqs: ['REQ-003'], linkedTasks: ['T5'],
    mismatchDetected: true,
    mismatchDetail: '实际实现使用了 JWT (PR #42)，与 ADR 中记录的 Session 方案不一致。建议更新 ADR 或修改实现。',
  },
]

const TECH_COMPONENTS: TechComponent[] = [
  { name: 'Web UI', layer: 'frontend', tech: 'React + Vite + Tailwind', status: 'active', adrRef: 'ADR-001' },
  { name: 'API Server', layer: 'backend', tech: 'Hono (Node.js)', status: 'active' },
  { name: 'Agent Loop', layer: 'agent', tech: 'TypeScript AsyncGenerator', status: 'active' },
  { name: 'Event Bus', layer: 'backend', tech: 'In-process Pub/Sub', status: 'active' },
  { name: 'Database', layer: 'data', tech: 'SQLite + Drizzle ORM', status: 'active', adrRef: 'ADR-002' },
  { name: 'Memory Store', layer: 'data', tech: 'File-based (.md + YAML)', status: 'active' },
  { name: 'MCP Server', layer: 'integration', tech: 'Model Context Protocol', status: 'planned', adrRef: 'ADR-004' },
  { name: 'Agent Runtime', layer: 'agent', tech: 'Python LangGraph', status: 'planned' },
  { name: 'CI/CD', layer: 'integration', tech: 'GitHub Actions + Docker', status: 'active', adrRef: 'ADR-003' },
]

const STATUS_STYLES: Record<string, { color: string; bg: string; label: string }> = {
  proposed: { color: 'text-warning', bg: 'bg-warning/10', label: 'Proposed' },
  accepted: { color: 'text-success', bg: 'bg-success/10', label: 'Accepted' },
  deprecated: { color: 'text-muted-foreground', bg: 'bg-muted', label: 'Deprecated' },
  superseded: { color: 'text-arch', bg: 'bg-arch/10', label: 'Superseded' },
}

const LAYER_COLORS: Record<string, string> = {
  frontend: 'border-l-wiki',
  backend: 'border-l-primary',
  data: 'border-l-agent',
  agent: 'border-l-arch',
  integration: 'border-l-req',
}

export function ArchitecturePage() {
  const [selectedAdr, setSelectedAdr] = useState<ADR | null>(null)
  const [view, setView] = useState<'adrs' | 'stack' | 'diagram'>('adrs')

  return (
    <div className="flex h-full">
      {/* Left Panel: ADR list / Stack */}
      <div className="w-80 flex-shrink-0 border-r border-border flex flex-col">
        <div className="h-11 flex items-center gap-2 px-4 border-b border-border">
          <Layers size={14} className="text-arch" />
          <span className="text-xs font-medium">Architecture</span>
          <button className="ml-auto w-6 h-6 rounded flex items-center justify-center hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
            <Plus size={12} />
          </button>
        </div>

        {/* View Tabs */}
        <div className="flex border-b border-border">
          {(['adrs', 'stack', 'diagram'] as const).map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                'flex-1 text-[10px] font-mono py-2 uppercase tracking-wider transition-colors',
                view === v ? 'text-arch border-b-2 border-b-arch' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {v}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto">
          {view === 'adrs' && (
            <div className="py-1">
              {ADRS.map(adr => {
                const style = STATUS_STYLES[adr.status]
                return (
                  <button
                    key={adr.id}
                    onClick={() => setSelectedAdr(adr)}
                    className={cn(
                      'w-full text-left px-4 py-3 hover:bg-secondary transition-colors',
                      selectedAdr?.id === adr.id && 'bg-arch/5 border-l-2 border-l-arch',
                    )}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] font-mono text-arch">{adr.id}</span>
                      <div className="flex items-center gap-1.5">
                        {adr.mismatchDetected && <AlertTriangle size={10} className="text-warning" />}
                        <span className={cn('text-[9px] font-mono px-1.5 py-0.5 rounded', style.bg, style.color)}>
                          {style.label}
                        </span>
                      </div>
                    </div>
                    <div className="text-xs leading-snug">{adr.title}</div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[10px] text-muted-foreground font-mono">{adr.date}</span>
                      {adr.linkedReqs.length > 0 && (
                        <span className="text-[9px] font-mono text-req">{adr.linkedReqs.join(', ')}</span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          )}

          {view === 'stack' && (
            <div className="py-2 px-3 space-y-1">
              {TECH_COMPONENTS.map(comp => (
                <div
                  key={comp.name}
                  className={cn(
                    'px-3 py-2 rounded-md border-l-2 bg-card',
                    LAYER_COLORS[comp.layer],
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">{comp.name}</span>
                    <span className={cn(
                      'text-[8px] font-mono px-1 py-0.5 rounded',
                      comp.status === 'active' ? 'bg-success/10 text-success' :
                      comp.status === 'planned' ? 'bg-primary/10 text-primary' :
                      'bg-muted text-muted-foreground',
                    )}>
                      {comp.status}
                    </span>
                  </div>
                  <div className="text-[10px] text-muted-foreground font-mono mt-0.5">{comp.tech}</div>
                  {comp.adrRef && (
                    <div className="text-[9px] font-mono text-arch mt-1">→ {comp.adrRef}</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {view === 'diagram' && (
            <div className="p-4">
              <div className="text-xs text-muted-foreground mb-4">System Architecture</div>
              <div className="space-y-3">
                {['frontend', 'backend', 'agent', 'data', 'integration'].map(layer => {
                  const layerComps = TECH_COMPONENTS.filter(c => c.layer === layer)
                  const layerNames: Record<string, string> = {
                    frontend: 'Frontend', backend: 'Backend', agent: 'Agent',
                    data: 'Data', integration: 'Integration',
                  }
                  return (
                    <div key={layer} className={cn('px-3 py-2 rounded-lg border-l-2', LAYER_COLORS[layer], 'bg-card')}>
                      <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">
                        {layerNames[layer]}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {layerComps.map(c => (
                          <span key={c.name} className="text-[10px] px-2 py-1 rounded bg-secondary">{c.name}</span>
                        ))}
                      </div>
                    </div>
                  )
                })}
                {/* Arrows between layers */}
                <div className="flex justify-center py-1">
                  <div className="w-px h-4 bg-border" />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right Panel: ADR Detail */}
      <div className="flex-1 overflow-auto">
        {selectedAdr ? (
          <div className="max-w-3xl mx-auto px-8 py-8">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-mono text-arch">{selectedAdr.id}</span>
              <span className={cn(
                'text-[10px] font-mono px-2 py-0.5 rounded',
                STATUS_STYLES[selectedAdr.status].bg,
                STATUS_STYLES[selectedAdr.status].color,
              )}>
                {STATUS_STYLES[selectedAdr.status].label}
              </span>
            </div>
            <h1 className="text-lg font-semibold mb-4">{selectedAdr.title}</h1>

            {/* Mismatch Alert */}
            {selectedAdr.mismatchDetected && (
              <div className="mb-6 px-4 py-3 rounded-lg bg-warning/5 border border-warning/20">
                <div className="flex items-center gap-2 mb-1.5">
                  <AlertTriangle size={14} className="text-warning" />
                  <span className="text-xs font-medium text-warning">Implementation Mismatch Detected</span>
                </div>
                <p className="text-xs text-foreground/80 leading-relaxed">{selectedAdr.mismatchDetail}</p>
                <div className="flex gap-2 mt-3">
                  <button className="text-[10px] font-mono px-3 py-1.5 rounded bg-arch/10 text-arch hover:bg-arch/20 transition-colors">
                    Update ADR to match code
                  </button>
                  <button className="text-[10px] font-mono px-3 py-1.5 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors">
                    Flag task for code fix
                  </button>
                </div>
              </div>
            )}

            {/* ADR Sections */}
            <div className="space-y-6">
              <Section title="Context" content={selectedAdr.context} />
              <Section title="Decision" content={selectedAdr.decision} />
              <Section title="Consequences" content={selectedAdr.consequences} />

              {/* Trace Links */}
              <div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">Trace Links</div>
                <div className="flex flex-wrap gap-2">
                  {selectedAdr.linkedReqs.map(r => (
                    <span key={r} className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded bg-req/10 text-req">
                      <Link2 size={9} /> {r}
                    </span>
                  ))}
                  {selectedAdr.linkedTasks.map(t => (
                    <span key={t} className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded bg-primary/10 text-primary">
                      <Link2 size={9} /> {t}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            Select an ADR or view the tech stack
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ title, content }: { title: string; content: string }) {
  return (
    <div>
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">{title}</div>
      <p className="text-sm leading-relaxed">{content}</p>
    </div>
  )
}
