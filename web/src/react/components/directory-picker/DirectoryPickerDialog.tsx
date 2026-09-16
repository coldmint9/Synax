import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, Folder, Loader2, RefreshCw, X } from 'lucide-react'
import { listRemoteDirectories, type RemoteDirectoryListing } from '../../../lib/api/fs'

/**
 * Server-side directory picker for the browser build.
 *
 * `<input type="file" webkitdirectory>` hands the renderer file handles, never a
 * usable directory path, so the browser cannot fill the "absolute path" field
 * the way the desktop build can. The runtime host lists directories instead and
 * the picker returns the chosen absolute path. The desktop build keeps using the
 * native dialog.
 */
export interface DirectoryPickerDialogProps {
  open: boolean
  /** Directory to start from; falls back to the host home directory. */
  initialPath?: string
  onClose: () => void
  onSelect: (selection: { path: string; name: string }) => void
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
  empty: '该目录下没有子目录。',
  truncated: '目录过多，仅显示前 2000 项。',
  showHidden: '显示隐藏目录',
  showIgnored: '显示构建目录',
  path: '目录路径',
  loading: '正在读取目录…',
  close: '关闭',
  failed: '读取目录失败',
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

export function DirectoryPickerDialog({ open, initialPath, onClose, onSelect, labels }: DirectoryPickerDialogProps) {
  // Shadow the module default so every string below can be localized by the caller.
  const label = labels ? { ...defaultLabels, ...labels } : defaultLabels
  const [listing, setListing] = useState<RemoteDirectoryListing | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [showIgnored, setShowIgnored] = useState(false)
  const request = useRef<AbortController | null>(null)

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
      setPathInput(next.path)
    } catch (cause) {
      if (controller.signal.aborted) return
      setError((cause as Error).message || String(cause))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [showHidden, showIgnored])

  useEffect(() => {
    if (!open) return
    void load(initialPath)
    return () => {
      request.current?.abort()
      request.current = null
    }
  }, [open, initialPath, load])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  const current = listing?.path ?? ''
  const crumbs = current ? breadcrumbs(current) : []

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog-content flex w-full max-w-2xl flex-col"
        role="dialog"
        aria-modal="true"
        aria-label={label.title}
        onClick={event => event.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">{label.title}</h2>
            <p className="mt-1 text-[11px] text-muted-foreground/70">{label.hint}</p>
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

        <label className="mb-3 block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">{label.path}</span>
          <div className="flex gap-2">
            <input
              type="text"
              className="import-input flex-1"
              value={pathInput}
              onChange={event => setPathInput(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') void load(pathInput.trim()) }}
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

        <div className="mb-2 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
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
            <span className="flex min-w-0 flex-wrap items-center gap-1">
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

        <div className="min-h-[16rem] flex-1 overflow-y-auto rounded-lg border border-border/50 bg-background/60">
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
          {listing?.entries.map(entry => (
            <button
              key={entry.path}
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition hover:bg-muted/40"
              title={entry.path}
              onClick={() => void load(entry.path)}
            >
              <Folder size={13} className={entry.hidden ? 'text-muted-foreground/60' : 'text-muted-foreground'} />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            </button>
          ))}
          {listing?.truncated && (
            <p className="px-3 py-2 text-[11px] text-warning">{label.truncated}</p>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
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

        <div className="mt-3 flex justify-end gap-2">
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
            disabled={!current || loading}
            onClick={() => onSelect({ path: current, name: listing?.name || current })}
          >
            <Check size={12} />
            {label.confirm}
          </button>
        </div>
      </div>
    </div>
  )
}
