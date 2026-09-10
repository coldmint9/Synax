import { useMemo } from 'react'
import { Accordion } from '@heroui/react'
import { Lock, Plug, Sparkles, Wrench } from 'lucide-react'
import type { AgentToolSummary, SessionCapabilities } from '../../../lib/api/agentRuntime'
import type { SkillSummary } from '../../../lib/api/skills'

const CATEGORY_ORDER = ['read', 'shell', 'task', 'write', 'skill', 'context', 'subagent'] as const

const CATEGORY_LABEL: Record<string, string> = {
  read: 'read',
  shell: 'shell',
  task: 'task',
  write: 'write',
  skill: 'skill',
  context: 'ctx',
  subagent: 'agent',
}

const CATEGORY_COLOR: Record<string, string> = {
  read: 'text-run/80',
  shell: 'text-run/80',
  task: 'text-run/80',
  write: 'text-warning/80',
  skill: 'text-electric/80',
  context: 'text-muted-foreground/70',
  subagent: 'text-success/80',
}

function sortTools(tools: AgentToolSummary[]): AgentToolSummary[] {
  return [...tools].sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a.category as typeof CATEGORY_ORDER[number])
    const bi = CATEGORY_ORDER.indexOf(b.category as typeof CATEGORY_ORDER[number])
    const aRank = ai === -1 ? CATEGORY_ORDER.length : ai
    const bRank = bi === -1 ? CATEGORY_ORDER.length : bi
    if (aRank !== bRank) return aRank - bRank
    return a.label.localeCompare(b.label)
  })
}

function ToolsCard({ tools }: { tools: SessionCapabilities['tools'] }) {
  const visibleIds = useMemo(() => new Set(tools.visible.map(tool => tool.id)), [tools.visible])
  const sorted = useMemo(() => sortTools(tools.available), [tools.available])

  if (sorted.length === 0) return null

  return (
    <Accordion className="gap-0 border-b border-border/40 px-0" defaultExpandedKeys={[]}>
      <Accordion.Item id="tools" aria-label="Tools" className="rounded-none border-0 bg-transparent shadow-none">
        <Accordion.Trigger className="flex w-full items-center gap-1 px-2 py-2 text-left">
          <span className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
            <Wrench size={9} />
            Tools
          </span>
          <span className="ml-auto text-[9px] text-muted-foreground/60">
            {tools.visible.length}/{tools.available.length}
          </span>
          <Accordion.Indicator className="text-muted-foreground/50 [&>svg]:size-3" />
        </Accordion.Trigger>
        <Accordion.Panel>
          <Accordion.Body className="px-2 pb-2 pt-0">
            <ul className="space-y-0.5">
              {sorted.map(tool => {
                const visible = visibleIds.has(tool.id)
                return (
                  <li
                    key={tool.id}
                    className={`flex items-start gap-1.5 ${visible ? '' : 'opacity-45'}`}
                    title={tool.description || tool.id}
                  >
                    {visible ? (
                      <span className={`mt-0.5 shrink-0 font-mono text-[8px] uppercase ${CATEGORY_COLOR[tool.category] ?? 'text-muted-foreground/60'}`}>
                        {CATEGORY_LABEL[tool.category] ?? tool.category.slice(0, 4)}
                      </span>
                    ) : (
                      <Lock size={9} className="mt-0.5 shrink-0 text-muted-foreground/50" />
                    )}
                    <span className="min-w-0 truncate text-[10px] text-foreground/80">{tool.label}</span>
                  </li>
                )
              })}
            </ul>
          </Accordion.Body>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  )
}

function SkillsCard({ skills }: { skills: SessionCapabilities['skills'] }) {
  const activeIds = useMemo(() => new Set(skills.active.map(skill => skill.id)), [skills.active])

  if (skills.active.length === 0 && skills.candidates.length === 0) return null

  const inactiveCandidates = skills.candidates.filter(skill => !activeIds.has(skill.id))

  return (
    <Accordion className="gap-0 border-b border-border/40 px-0" defaultExpandedKeys={[]}>
      <Accordion.Item id="skills" aria-label="Skills" className="rounded-none border-0 bg-transparent shadow-none">
        <Accordion.Trigger className="flex w-full items-center gap-1 px-2 py-2 text-left">
          <span className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
            <Sparkles size={9} />
            Skills
          </span>
          <span className="ml-auto text-[9px] text-muted-foreground/60">{skills.active.length} active</span>
          <Accordion.Indicator className="text-muted-foreground/50 [&>svg]:size-3" />
        </Accordion.Trigger>
        <Accordion.Panel>
          <Accordion.Body className="px-2 pb-2 pt-0">
            {skills.active.length > 0 ? (
              <ul className="space-y-1">
                {skills.active.map(skill => (
                  <SkillRow key={skill.id} skill={skill} active />
                ))}
              </ul>
            ) : (
              <div className="text-[10px] text-muted-foreground/50">No active skills</div>
            )}
            {inactiveCandidates.length > 0 && (
              <div className="mt-2">
                <div className="text-[8px] uppercase tracking-wider text-muted-foreground/50">Available</div>
                <ul className="mt-0.5 space-y-1">
                  {inactiveCandidates.map(skill => (
                    <SkillRow key={skill.id} skill={skill} />
                  ))}
                </ul>
              </div>
            )}
          </Accordion.Body>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  )
}

function SkillRow({ skill, active = false }: { skill: SkillSummary; active?: boolean }) {
  return (
    <li className={active ? '' : 'opacity-55'} title={skill.description || skill.id}>
      <div className="flex items-center gap-1.5">
        <Sparkles
          size={10}
          className={active ? 'shrink-0 text-electric' : 'shrink-0 text-muted-foreground/40'}
        />
        <span className={`truncate text-[10px] ${active ? 'font-medium text-foreground/90' : 'text-foreground/70'}`}>
          {skill.label}
        </span>
      </div>
      {skill.description && (
        <p className="ml-[18px] line-clamp-2 text-[9px] leading-snug text-muted-foreground/60">
          {skill.description}
        </p>
      )}
    </li>
  )
}

function McpCard({ mcp }: { mcp: SessionCapabilities['mcp'] }) {
  const servers = mcp?.servers ?? []
  const toolCount = servers.reduce((sum, server) => sum + server.toolCount, 0)
  const active = servers.filter(server => server.enabled).length

  return (
    <Accordion className="gap-0 border-b border-border/40 px-0" defaultExpandedKeys={[]}>
      <Accordion.Item id="mcp" aria-label="MCP" className="rounded-none border-0 bg-transparent shadow-none">
        <Accordion.Trigger className="flex w-full items-center gap-1 px-2 py-2 text-left">
          <span className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
            <Plug size={9} />
            MCP
          </span>
          <span className="ml-auto text-[9px] text-muted-foreground/60">
            {active > 0 ? `${servers.length} 个已挂载 · ${toolCount} tools` : '未挂载'}
          </span>
          <Accordion.Indicator className="text-muted-foreground/50 [&>svg]:size-3" />
        </Accordion.Trigger>
        <Accordion.Panel>
          <Accordion.Body className="px-2 pb-2 pt-0">
            {servers.length === 0 ? (
              <div className="text-[10px] text-muted-foreground/50">
                该会话未挂载 MCP server（在项目设置中配置后随会话挂载）
              </div>
            ) : (
              <ul className="space-y-1">
                {servers.map(server => (
                  <li key={server.id} className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${server.enabled ? 'bg-success' : 'bg-muted-foreground/30'}`}
                    />
                    <span className="min-w-0 flex-1 truncate text-[10px] text-foreground/85" title={server.id}>
                      {server.name}
                    </span>
                    <span className="shrink-0 text-[9px] text-muted-foreground/60">
                      {server.enabled ? `${server.toolCount} tools` : '已停用'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Accordion.Body>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  )
}

export function SessionCapabilitiesPanel({ capabilities }: { capabilities: SessionCapabilities }) {
  return (
    <>
      <ToolsCard tools={capabilities.tools} />
      <SkillsCard skills={capabilities.skills} />
      <McpCard mcp={capabilities.mcp} />
    </>
  )
}
