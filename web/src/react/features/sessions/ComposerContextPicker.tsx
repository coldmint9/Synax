import { useEffect, useState } from 'react'
import { Popover } from '@heroui/react'
import { ArrowLeft, BookOpen, FileText, Plus, Plug, Sparkles } from 'lucide-react'
import { agentRuntimeApi, type TurnReference } from '../../../lib/api/agentRuntime'
import { useLocale } from '../../../hooks/useLocale'

const contextTypes = [
  { id: 'skill', zh: '技能', en: 'Skill', Icon: Sparkles },
  { id: 'mcp', zh: 'MCP 服务', en: 'MCP server', Icon: Plug },
  { id: 'file', zh: '项目文件', en: 'Project file', Icon: FileText },
  { id: 'wiki', zh: 'Wiki 文档', en: 'Wiki document', Icon: BookOpen },
] as const

export function ComposerContextPicker({ projectId, sessionId, backendId, references, onChange, disabled, onOpen, onOpenChange }: {
  projectId: string; sessionId?: string; backendId: string; references: TurnReference[]
  onChange: (references: TurnReference[]) => void; disabled: boolean; onOpen: () => void; onOpenChange?: (open: boolean) => void
}) {
  const { locale } = useLocale(), zh = locale === 'zh'
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<TurnReference['kind'] | null>(null)
  const [search, setSearch] = useState('')
  const [options, setOptions] = useState<TurnReference[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setOpen(false); setKind(null); setSearch('') }, [projectId, sessionId, backendId, disabled])
  useEffect(() => {
    if (!open || !kind) return
    let current = true
    setOptions([]); setLoading(true); setError('')
    const timer = window.setTimeout(() => {
      void agentRuntimeApi.listReferenceOptions(projectId, kind, search, sessionId)
        .then(result => { if (current) setOptions(result.items) })
        .catch(err => { if (current) setError(err instanceof Error ? err.message : String(err)) })
        .finally(() => { if (current) setLoading(false) })
    }, 150)
    return () => { current = false; clearTimeout(timer) }
  }, [open, kind, search, projectId, sessionId])
  useEffect(() => { onOpenChange?.(open && !disabled); return () => onOpenChange?.(false) }, [open, disabled, onOpenChange])
  const selectedType = contextTypes.find(type => type.id === kind)
  return <Popover isOpen={open && !disabled} onOpenChange={next => {
    setOpen(next && !disabled)
    if (next) { onOpen(); setKind(null); setSearch(''); setError('') }
  }}>
    <Popover.Trigger<'button'> render={props => <button {...props} type="button" />}
      disabled={disabled} aria-label={zh ? '添加上下文' : 'Add context'}
      className="goal-dock-composer-chip inline-flex size-7 shrink-0 items-center justify-center rounded-full"><Plus size={16}/></Popover.Trigger>
    <Popover.Content placement="top start" offset={8} className="session-context-picker">
      {kind ? <>
        <div className="session-context-picker-heading"><button type="button" aria-label={zh ? '返回上下文类型' : 'Back to context types'} onClick={() => { setKind(null); setSearch('') }}><ArrowLeft size={14}/></button><span>{zh ? selectedType?.zh : selectedType?.en}</span></div>
        <input key={kind} autoFocus aria-label={zh ? '搜索上下文' : 'Search context'} placeholder={zh ? '搜索名称…' : 'Search by name…'} value={search} onChange={event => setSearch(event.target.value)} className="session-context-picker-search" />
        <div className="session-context-picker-results">
          {options.map(ref => {
            const added = references.some(item => item.kind === ref.kind && item.id === ref.id)
            return <button type="button" key={ref.id} className="session-context-picker-option" disabled={added || references.length >= 20} onClick={() => { onChange([...references, ref]); setOpen(false) }}>
              <span>{ref.label ?? ref.id}</span><small>{added ? (zh ? '已添加' : 'Added') : ref.label !== ref.id ? ref.id : ''}</small>
            </button>
          })}
        </div>
        {loading && <p role="status">{zh ? '正在加载…' : 'Loading…'}</p>}
        {!loading && error && <p role="alert">{error}</p>}
        {!loading && !error && !options.length && <p role="status">{zh ? '没有匹配项' : 'No matches'}</p>}
        {references.length >= 20 && <p role="status">{zh ? '最多添加 20 个上下文' : 'Up to 20 references'}</p>}
      </> : <>
        <div className="session-context-picker-heading">{zh ? '添加上下文' : 'Add context'}</div>
        {contextTypes.map(({ id, Icon, ...labels }) => {
          const unavailable = backendId !== 'native' && (id === 'skill' || id === 'mcp')
          return <button type="button" key={id} disabled={unavailable} className="session-context-picker-option" onClick={() => setKind(id)}>
            <Icon size={15}/><span>{zh ? labels.zh : labels.en}{unavailable && <small>{zh ? '由此后端的原生配置管理' : 'Managed by this backend'}</small>}</span>
          </button>
        })}
      </>}
    </Popover.Content>
  </Popover>
}
