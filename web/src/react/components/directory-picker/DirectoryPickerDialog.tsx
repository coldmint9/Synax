import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, ChevronRight, Folder, Loader2, RefreshCw, X } from 'lucide-react'
import { listRemoteDirectories, type RemoteDirectoryListing } from '../../../lib/api/fs'
import { useDialogFocus } from './useDialogFocus'
import { useLocale } from '../../../hooks/useLocale'
import '../../features/workspace/workspaceProjects.css'

/**
 * Directory picker for paths on the runtime host, including local Electron hosts.
 *
 * `<input type="file" webkitdirectory>` hands the renderer file handles, never a
 * usable directory path, so the browser cannot fill the "absolute path" field
 * the way the desktop build can. The runtime host lists directories instead and
 * the picker returns the chosen absolute paths.
 */
export interface DirectoryPickerDialogProps {
  open: boolean
  /** Directory to start from; falls back to the host home directory. */
  initialPath?: string
  onClose: () => void
  onSelect: (selection: { path: string; name: string }) => void
  multiple?: boolean
  onSelectMultiple?: (selections: { path: string; name: string }[]) => void
  /** Override individual strings so localized callers can translate the dialog. */
  labels?: Partial<typeof defaultLabels>
}

const defaultLabels = {
  title: '选择项目目录',
  hint: '以下目录位于运行 Synax 的机器上，文件内容不会被读取。',
  up: '上级目录',
  home: '主目录',
  refresh: '刷新',
  cancel: '取消',
  confirm: '选择此目录',
  confirmMultiple: '添加所选项目',
  select: '选择',
  selectCurrent: '选择当前目录',
  deselectCurrent: '取消选择当前目录',
  selectedCount: '已选择 {count} 个项目',
  empty: '该目录下没有子目录。',
  truncated: '目录过多，仅显示前 2000 项。',
  showHidden: '显示隐藏目录',
  showIgnored: '显示构建目录',
  path: '目录路径',
  loading: '正在读取目录…',
  close: '关闭',
  failed: '读取目录失败',
  selectionHint: '勾选项目以加入工作区，点击文件夹名称进入目录。',
  removeSelection: '取消选择',
}

const englishLabels: typeof defaultLabels = {
  title: 'Choose project directory', hint: 'Browse directories on the machine running Synax.',
  up: 'Parent directory', home: 'Home', refresh: 'Refresh', cancel: 'Cancel',
  confirm: 'Choose this directory', confirmMultiple: 'Add selected projects',
  select: 'Select', selectCurrent: 'Select current directory', deselectCurrent: 'Deselect current directory',
  selectedCount: '{count} projects selected', empty: 'No subdirectories here.',
  truncated: 'Showing the first 2000 directories.', showHidden: 'Show hidden directories',
  showIgnored: 'Show build directories', path: 'Directory path', loading: 'Reading directories…',
  close: 'Close', failed: 'Failed to read directory',
  selectionHint: 'Check projects to add them. Click a folder name to browse inside.', removeSelection: 'Deselect',
}

/** Breadcrumb segments; each one is clickable to jump back up. */
function breadcrumbs(path: string): { name: string; path: string }[] {
  const separator = path.includes('\\') ? '\\' : '/'
  const parts = path.split(separator).filter(Boolean)
  const crumbs: { name: string; path: string }[] = []
  let current = separator === '\\' ? '' : ''
  parts.forEach((part, index) => {
    current = index === 0 && separator === '/' ? `/${part}` : `${current}${current && current !== '/' ? separator : ''}${part}`
    crumbs.push({ name: part, path: current })
  })
  return crumbs
}

export function DirectoryPickerDialog({ open, ...props }: DirectoryPickerDialogProps) {
  // Each opening owns its selection, navigation and in-flight listing request.
  return open ? <DirectoryPickerContent key={props.initialPath} {...props} /> : null
}

function DirectoryPickerContent({ initialPath, onClose, onSelect, labels, multiple = false, onSelectMultiple }: Omit<DirectoryPickerDialogProps, 'open'>) {
  // Shadow the module default so every string below can be localized by the caller.
  const { locale } = useLocale()
  const label = { ...(locale === 'en' ? englishLabels : defaultLabels), ...labels }
  const [listing, setListing] = useState<RemoteDirectoryListing | null>(null)
  const [pathInput, setPathInput] = useState(initialPath ?? '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [showIgnored, setShowIgnored] = useState(false)
  const request = useRef<AbortController | null>(null)
  const [selected, setSelected] = useState<{ path: string; name: string }[]>([])
  const lastPath = useRef<string | undefined>(initialPath)
  const dialogRef = useDialogFocus(onClose)
  const toggle = (entry: { path: string; name: string }) => setSelected(items =>
    items.some(item => item.path === entry.path)
      ? items.filter(item => item.path !== entry.path)
      : [...items, { path: entry.path, name: entry.name }])

  const load = useCallback(async (target?: string) => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setError(null)
    try {
      const next = await listRemoteDirectories(target, {
        showHidden,
        showIgnored,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setListing(next)
      lastPath.current = next.path
      setPathInput(next.path)
    } catch (cause) {
      if (controller.signal.aborted) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [showHidden, showIgnored])

  useEffect(() => {
    void load(lastPath.current)
    return () => {
      request.current?.abort()
      request.current = null
    }
  }, [load])

  const current = listing?.path ?? ''
  const crumbs = current ? breadcrumbs(current) : []

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="dialog-content workspace-directory-picker flex min-h-0 min-w-0 flex-col overflow-hidden"
        style={{ width: '42rem', maxWidth: 'calc(100vw - 2rem)', height: '37.5rem', maxHeight: 'calc(100dvh - 2rem)' }}
        role="dialog"
        aria-modal="true"
        aria-label={label.title}
        onClick={event => event.stopPropagation()}
      >
        <div className="mb-3 flex shrink-0 items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">{label.title}</h2>
            <p className="mt-1 text-[11px] text-muted-foreground/70">{multiple ? label.selectionHint : label.hint}</p>
          </div>
          <button
            type="button"
            aria-label={label.close}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
        <label className="mb-3 block shrink-0">
          <span className="mb-1.5 block text-xs font-medium text-foreground">{label.path}</span>
          <div className="flex gap-2">
            <input
              type="text"
              data-dialog-autofocus
              aria-label={label.path}
              className="import-input min-w-0 flex-1"
              value={pathInput}
              onChange={event => setPathInput(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void load(pathInput.trim())
                }
              }}
              placeholder="/path/to/project"
              spellCheck={false}
            />
            <button
              type="button"
              aria-label={label.refresh}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/50 px-3 py-2 text-xs font-medium text-foreground transition hover:bg-muted/40 disabled:opacity-50"
              disabled={loading || !pathInput.trim()}
              onClick={() => void load(pathInput.trim())}
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              {label.refresh}
            </button>
          </div>
        </label>

        <div className="mb-2 flex shrink-0 items-center gap-1 overflow-x-auto whitespace-nowrap text-[11px] text-muted-foreground">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition hover:bg-muted/40 hover:text-foreground"
            onClick={() => void load(listing?.parent ?? undefined)}
            disabled={!listing?.parent}
            aria-label={label.up}
          >
            <ArrowUp size={11} />
            {label.up}
          </button>
          {listing?.home && (
            <button
              type="button"
              className="rounded-md px-1.5 py-0.5 transition hover:bg-muted/40 hover:text-foreground"
              onClick={() => void load(listing.home)}
            >
              {label.home}
            </button>
          )}
          {crumbs.length > 1 && (
            <span className="flex items-center gap-1">
              {crumbs.map((crumb, index) => (
                <span key={crumb.path} className="flex items-center gap-1">
                  {index > 0 && <span className="text-muted-foreground/40">/</span>}
                  <button
                    type="button"
                    className="max-w-[12rem] truncate rounded-md px-1 py-0.5 transition hover:bg-muted/40 hover:text-foreground"
                    title={crumb.path}
                    onClick={() => void load(crumb.path)}
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
            </span>
          )}
        </div>

        <div className="min-h-24 flex-1 overflow-y-auto overscroll-contain rounded-lg border border-border/50 bg-background/60" role="region" aria-label={label.title} aria-busy={loading}>
          {loading && (
            <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 size={13} className="animate-spin" />
              {label.loading}
            </p>
          )}
          {error && (
            <p role="alert" className="break-words px-3 py-2 text-xs text-destructive">{error}</p>
          )}
          {!loading && !error && listing?.entries.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">{label.empty}</p>
          )}
          {!loading && !error && listing?.entries.map(entry => (
            <div key={entry.path} className="workspace-directory-entry" data-selected={selected.some(item => item.path === entry.path) || undefined}>
              {multiple && <input type="checkbox" aria-label={`${label.select} ${entry.name}`} title={entry.path} checked={selected.some(item => item.path === entry.path)} onChange={() => toggle(entry)} />}
              <button
                type="button"
                className="workspace-directory-open"
                title={entry.path}
                onClick={() => void load(entry.path)}
              >
                <Folder size={13} className={entry.hidden ? 'text-muted-foreground/60' : 'text-muted-foreground'} />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span><ChevronRight size={12} className="text-muted-foreground/50" />
              </button>
            </div>
          ))}
          {!loading && !error && listing?.truncated && (
            <p className="px-3 py-2 text-[11px] text-warning">{label.truncated}</p>
          )}
        </div>

        <div className="mt-3 flex shrink-0 flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={showHidden} onChange={event => setShowHidden(event.target.checked)} />
            {label.showHidden}
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={showIgnored} onChange={event => setShowIgnored(event.target.checked)} />
            {label.showIgnored}
          </label>
          <span className="ml-auto min-w-0 truncate font-mono" title={current}>{current}</span>
        </div>
        </div>

        {multiple && selected.length > 0 && <div className="workspace-directory-selection" aria-label={label.selectedCount.replace('{count}', String(selected.length))}>
          {selected.map(item => <button type="button" key={item.path} title={item.path} aria-label={`${label.removeSelection} ${item.name}`} onClick={() => toggle(item)}><Folder size={11} /><span>{item.name}</span><X size={11} /></button>)}
        </div>}
        {multiple && <div className="mt-3 flex shrink-0 items-center justify-between gap-2 text-xs">
          <span role="status">{label.selectedCount.replace('{count}', String(selected.length))}</span>
          <button type="button" disabled={!current || loading || Boolean(error)} onClick={() => toggle({ path: current, name: listing?.name || current })}>
            {selected.some(item => item.path === current) ? label.deselectCurrent : label.selectCurrent}
          </button>
        </div>}
        <div className="mt-3 flex shrink-0 justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-border/50 px-4 py-2 text-xs font-medium text-foreground transition hover:bg-muted/40"
            onClick={onClose}
          >
            {label.cancel}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
            disabled={multiple ? selected.length === 0 || !onSelectMultiple : !current || loading || Boolean(error)}
            onClick={() => multiple ? onSelectMultiple?.(selected) : onSelect({ path: current, name: listing?.name || current })}
          >
            <Check size={12} />
            {multiple ? `${labels?.confirm ?? label.confirmMultiple} (${selected.length})` : label.confirm}
          </button>
        </div>
      </div>
    </div>
  )
}
