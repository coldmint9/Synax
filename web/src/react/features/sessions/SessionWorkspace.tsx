import { useMemo } from 'react'
import { CheckCircle2, Circle, FileEdit, FilePlus, FileX, File } from 'lucide-react'
import { useContextStore } from '../../state/contextStore'
import { useDebugConsole } from '../debug-console/debugConsoleStore'

interface FileChange { path: string; changeType: 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown' }
interface TaskItem { id: string; label: string; done: boolean }

const CHANGE_ICON = { added: FilePlus, modified: FileEdit, deleted: FileX, renamed: File, unknown: File }
const CHANGE_COLOR = {
  added: 'text-[hsl(var(--success))]', modified: 'text-[hsl(var(--warning))]',
  deleted: 'text-[hsl(var(--destructive))]', renamed: 'text-muted-foreground', unknown: 'text-muted-foreground',
}

export function useHasWorkspaceContent(mode: 'context' | 'agent'): boolean {
  const entries = useContextStore((s) => s.entries)
  const events = useDebugConsole((s) => s.events)

  return useMemo(() => {
    const source = mode === 'agent' ? events : entries
    for (const item of source) {
      const p = mode === 'agent'
        ? (item as { payload: Record<string, unknown> }).payload
        : (item as { metadata: Record<string, unknown>; contentType: string }).metadata
      if (mode === 'context' && (item as { contentType: string }).contentType !== 'tool_call') continue
      const mut = (p?.mutability as string) ?? ''
      if (mut === 'write' || mut === 'task') return true
    }
    return false
  }, [mode, entries, events])
}

export function SessionWorkspace({ mode }: { mode: 'context' | 'agent' }) {
  const entries = useContextStore((s) => s.entries)
  const events = useDebugConsole((s) => s.events)

  const fileChanges = useMemo<FileChange[]>(() => {
    const paths = new Map<string, FileChange>()
    const source = mode === 'agent' ? events : entries
    for (const item of source) {
      const p = mode === 'agent'
        ? (item as { payload: Record<string, unknown> }).payload
        : (item as { metadata: Record<string, unknown>; contentType: string }).metadata
      if (mode === 'context' && (item as { contentType: string }).contentType !== 'tool_call') continue
      if ((p?.mutability as string) !== 'write') continue
      const input = (p.inputSummary as string) ?? ''
      const match = input.match(/^(\S+)/)
      if (match) paths.set(match[1], { path: match[1], changeType: 'modified' })
    }
    return [...paths.values()]
  }, [mode, entries, events])

  const tasks = useMemo<TaskItem[]>(() => {
    const items: TaskItem[] = []
    const source = mode === 'agent' ? events : entries
    for (const item of source) {
      const p = mode === 'agent'
        ? (item as { payload: Record<string, unknown>; id: string }).payload
        : (item as { metadata: Record<string, unknown>; contentType: string; id: string }).metadata
      if (mode === 'context' && (item as { contentType: string }).contentType !== 'tool_call') continue
      if ((p?.mutability as string) !== 'task') continue
      const id = (item as { id: string }).id
      const label = (p.inputSummary as string) ?? 'Task'
      const status = (p.status as string) ?? ''
      items.push({ id, label, done: status === 'completed' })
    }
    return items
  }, [mode, entries, events])

  if (fileChanges.length === 0 && tasks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[10px] text-muted-foreground/50">
        暂无工作产出
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto text-[10px]">
      {tasks.length > 0 && (
        <div className="border-b border-border/40 px-2 py-1.5">
          <div className="mb-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
            Tasks ({tasks.length})
          </div>
          <ul className="space-y-0.5">
            {tasks.map((t) => (
              <li key={t.id} className="flex items-center gap-1.5">
                {t.done
                  ? <CheckCircle2 size={10} className="shrink-0 text-[hsl(var(--success))]" />
                  : <Circle size={10} className="shrink-0 text-muted-foreground/50" />}
                <span className={t.done ? 'line-through text-muted-foreground' : 'text-foreground/80'}>
                  {t.label}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {fileChanges.length > 0 && (
        <div className="px-2 py-1.5">
          <div className="mb-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
            Files ({fileChanges.length})
          </div>
          <ul className="space-y-0.5">
            {fileChanges.map((f) => {
              const Icon = CHANGE_ICON[f.changeType]
              return (
                <li key={f.path} className="flex items-center gap-1.5 font-mono">
                  <Icon size={10} className={`shrink-0 ${CHANGE_COLOR[f.changeType]}`} />
                  <span className="truncate text-foreground/80" title={f.path}>
                    {f.path.split('/').pop()}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
