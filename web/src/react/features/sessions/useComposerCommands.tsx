import { composerMenuPosition } from './composerMenuPosition'
import { createPortal } from 'react-dom'
import { SessionModePicker } from './SessionModePicker'
import { ComposerContextPicker } from './ComposerContextPicker'
import { useEffect, useLayoutEffect, useId, useRef, useState, type KeyboardEvent, type CSSProperties } from 'react'
import { BookOpen, FileText, ListTodo, Plug, Sparkles, Target, X } from 'lucide-react'
import { agentRuntimeApi, type AgentSessionMode, type TurnReference } from '../../../lib/api/agentRuntime'
import { useLocale } from '../../../hooks/useLocale'

const commands = [
  { id: 'skill', zh: '技能', en: 'Skill', Icon: Sparkles },
  { id: 'mcp', zh: 'MCP 服务', en: 'MCP server', Icon: Plug },
  { id: 'file', zh: '项目文件', en: 'Project file', Icon: FileText },
  { id: 'wiki', zh: 'Wiki 文档', en: 'Wiki document', Icon: BookOpen },
  { id: 'plan', zh: '计划模式', en: 'Plan mode', Icon: ListTodo },
  { id: 'goal', zh: '目标模式', en: 'Goal mode', Icon: Target },
] as const

type CommandId = typeof commands[number]['id']
type Query = { start: number; end: number; command?: TurnReference['kind']; search: string }
function findQuery(value: string, cursor: number): Query | null {
  const before = value.slice(0, cursor)
  const detail = /(?:^|\s)\/(skill|mcp|file|wiki)\s+([^\n]*)$/.exec(before)
  if (detail) return { start: detail.index + detail[0].indexOf('/'), end: cursor, command: detail[1] as TurnReference['kind'], search: detail[2] }
  const root = /(?:^|\s)\/([a-z]*)$/i.exec(before)
  return root ? { start: cursor - root[1].length - 1, end: cursor, search: root[1] } : null
}

export function useComposerCommands({ projectId, sessionId, backendId, content, setContent, references, setReferences, mode, modeEnabled, onModeChange, disabled }: {
  projectId: string; sessionId?: string; backendId: string; content: string; setContent: (value: string) => void
  references: TurnReference[]; setReferences: (value: TurnReference[]) => void
  mode: AgentSessionMode | 'plan_node'; modeEnabled: boolean; onModeChange: (value: AgentSessionMode) => Promise<void>
  disabled: boolean
}) {
  const { locale } = useLocale(), zh = locale === 'zh'
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const [contextOpen, setContextOpen] = useState(false)
  const [query, setQuery] = useState<Query | null>(null)
  const [options, setOptions] = useState<TurnReference[]>([])
  const [active, setActive] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [menuPosition, setMenuPosition] = useState<CSSProperties>({ left: 16, bottom: 16, width: 360, maxHeight: 320 })
  const native = backendId === 'native'
  useEffect(() => { setQuery(null); setError('') }, [sessionId, projectId, backendId, disabled])
  useEffect(() => {
    if (!query?.command) { setLoading(false); return }
    let current = true
    setOptions([]); setLoading(true); setError('')
    const timer = window.setTimeout(() => {
      void agentRuntimeApi.listReferenceOptions(projectId, query.command!, query.search, sessionId)
        .then(result => { if (current) setOptions(result.items) })
        .catch(err => { if (current) setError(err instanceof Error ? err.message : String(err)) })
        .finally(() => { if (current) setLoading(false) })
    }, 150)
    return () => { current = false; clearTimeout(timer) }
  }, [projectId, sessionId, query?.command, query?.search])
  useEffect(() => {
    if (!query) return
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && event.target !== inputRef.current) setQuery(null)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [Boolean(query)])
  useEffect(() => { menuRef.current?.querySelector(`[id="${CSS.escape(listId)}-${active}"]`)?.scrollIntoView({ block: 'nearest' }) }, [active, listId])

  useLayoutEffect(() => {
    if (!query) return
    const measure = () => {
      const rect = (inputRef.current?.closest('.goal-dock-composer') ?? inputRef.current)?.getBoundingClientRect()
      if (!rect) return
      const viewport = window.visualViewport
      setMenuPosition(composerMenuPosition(rect, {
        width: viewport?.width ?? window.innerWidth,
        height: viewport?.height ?? window.innerHeight,
        layoutHeight: window.innerHeight,
        top: viewport?.offsetTop, left: viewport?.offsetLeft,
      }))
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (inputRef.current) observer?.observe(inputRef.current)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    window.visualViewport?.addEventListener('resize', measure)
    window.visualViewport?.addEventListener('scroll', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
      window.visualViewport?.removeEventListener('resize', measure)
      window.visualViewport?.removeEventListener('scroll', measure)
    }
  }, [Boolean(query), references.length, mode])

  const unavailable = (id: CommandId) => {
    if ((id === 'skill' || id === 'mcp') && !native) return zh ? '此后端使用原生配置' : 'Managed by this backend'
    if (['plan', 'goal'].includes(id) && !modeEnabled) return zh ? '仅支持 Synax，且须会话空闲、无待处理请求' : 'Requires an idle Synax session without pending requests'
    return undefined
  }
  const rows = query?.command
    ? options.map(ref => ({ id: `${ref.kind}:${ref.id}`, title: ref.label ?? ref.id, detail: ref.label !== ref.id ? ref.id : '', command: ref.kind as CommandId, ref, disabled: references.some(item => item.kind === ref.kind && item.id === ref.id) ? (zh ? '已添加' : 'Added') : unavailable(ref.kind) }))
    : commands.filter(cmd => cmd.id.includes(query?.search.toLowerCase() ?? '')).map(cmd => ({ id: cmd.id, title: `/${cmd.id}`, detail: zh ? cmd.zh : cmd.en, command: cmd.id, ref: undefined as TurnReference | undefined, disabled: unavailable(cmd.id) }))

  const updateQuery = (value: string, cursor: number) => {
    if (disabled) return
    const next = findQuery(value, cursor)
    setQuery(next)
    if (next?.search !== query?.search || next?.command !== query?.command) { setActive(0); setError('') }
  }
  const replaceQuery = (replacement: string, keepOpen = false) => {
    if (!query) return
    const value = content.slice(0, query.start) + replacement + content.slice(query.end)
    const cursor = query.start + replacement.length
    setContent(value)
    setQuery(keepOpen ? findQuery(value, cursor) : null)
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(cursor, cursor) })
  }
  const select = async (index: number) => {
    const row = rows[index]
    if (!row || row.disabled || disabled) return
    if (row.ref) {
      if (references.length >= 20) { setError(zh ? '最多添加 20 个引用' : 'Up to 20 references'); return }
      setReferences([...references, row.ref]); replaceQuery(''); return
    }
    if (row.command === 'plan' || row.command === 'goal') {
      try { await onModeChange(row.command); replaceQuery('') }
      catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    } else { replaceQuery(`/${row.command} `, true); setActive(0) }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!query || disabled || event.nativeEvent.isComposing || event.keyCode === 229) return false
    if (event.key === 'Escape') { event.preventDefault(); setQuery(null); return true }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + Math.max(rows.length, 1)) % Math.max(rows.length, 1)); return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault(); if (!loading) void select(Math.min(active, Math.max(rows.length - 1, 0))); return true
    }
    return false
  }
  const trigger = <><ComposerContextPicker projectId={projectId} sessionId={sessionId} backendId={backendId}
    references={references} onChange={setReferences} disabled={disabled} onOpenChange={setContextOpen} onOpen={() => setQuery(null)} />
    {native && <SessionModePicker mode={mode} disabled={!modeEnabled || disabled}
      description={zh ? '选择工作方式' : 'Choose how to work'}
      onChange={value => { void onModeChange(value).catch(err => setError(String(err))) }} onOpenChange={setContextOpen} />}
  </>
  const header = references.length > 0 && <div className="session-composer-reference-tags" aria-label={zh ? '本条消息引用' : 'References for this message'}>
    {references.map(ref => { const Icon = commands.find(cmd => cmd.id === ref.kind)!.Icon; return <span key={`${ref.kind}:${ref.id}`} className="session-composer-reference-tag" data-kind={ref.kind} title={ref.id}><Icon size={12}/><span>{ref.kind} · {ref.label ?? ref.id}</span><button type="button" disabled={disabled} aria-label={`${zh ? '移除' : 'Remove'} ${ref.label ?? ref.id}`} onClick={() => setReferences(references.filter(item => item !== ref))}><X size={12}/></button></span> })}
  </div>
  const menu = query && !disabled && createPortal(<div ref={menuRef} className="session-composer-command-menu" style={menuPosition} onMouseDown={event => event.preventDefault()}>
    <div className="session-composer-command-heading">{query.command ? `/${query.command} · ${zh ? '输入名称搜索' : 'Search by name'}` : (zh ? '选择命令' : 'Choose a command')}</div>
    <div id={listId} role="listbox" aria-label={zh ? '斜杠命令' : 'Slash commands'}>
      {rows.map((row, index) => { const Icon = commands.find(cmd => cmd.id === row.command)!.Icon; return <div key={row.id} id={`${listId}-${index}`} role="option" aria-selected={index === active} aria-disabled={Boolean(row.disabled)} className="session-composer-command-option" onMouseEnter={() => setActive(index)} onClick={() => void select(index)}><Icon size={15}/><span><strong>{row.title}</strong><small>{row.disabled || row.detail}</small></span></div> })}
    </div>
    {loading && <p role="status">{zh ? '正在加载…' : 'Loading…'}</p>}
    {!loading && rows.length === 0 && <p role={error ? "alert" : "status"}>{error || (zh ? '没有匹配项' : 'No matches')}</p>}
    {error && rows.length > 0 && <p role="alert">{error}</p>}
    <div className="session-composer-command-help"><span>↑ ↓ {zh ? '选择' : 'navigate'}</span><span>↵ {zh ? '确认' : 'select'}</span><span>esc {zh ? '关闭' : 'close'}</span></div>
  </div>, document.body)
  return { overlayOpen: contextOpen || Boolean(query), inputRef, onInput: updateQuery, onKeyDown, header, trigger, menu, open: Boolean(query) && !disabled, listId, activeId: rows.length ? `${listId}-${Math.min(active, rows.length - 1)}` : undefined }
}
