import { useId, useState, type ReactNode } from 'react'
import { Button } from '@heroui/react'
import { ChevronDown, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { SkillSourceRecord } from '../../../lib/api/skills'

export type SourceFilter = 'all' | 'installed' | string

const PROTECTED_SOURCE_IDS = new Set([
  'synax-builtin',
  'default-remote',
])

interface Props {
  sources: SkillSourceRecord[]
  selectedSource: SourceFilter
  busy: string | null
  labels: {
    title: string
    quickFilters: string
    all: string
    installed: string
    localSources: string
    remoteSources: string
    addSource: string
    syncSource: string
    removeSource: string
  }
  onSelectSource: (sourceId: SourceFilter) => void
  onAddSource: () => void
  onSyncSource: (sourceId: string) => void
  onRemoveSource: (sourceId: string) => void
}

function isRemoteSource(source: SkillSourceRecord): boolean {
  return source.type === 'well-known' || source.type === 'git-index' || source.type === 'skills-sh'
}

export function SkillMarketSidebar({
  sources,
  selectedSource,
  busy,
  labels,
  onSelectSource,
  onAddSource,
  onSyncSource,
  onRemoveSource,
}: Props) {
  const [filtersOpen, setFiltersOpen] = useState(false)
  const filtersId = useId()
  const selectedLabel = selectedSource === 'all' ? labels.all : selectedSource === 'installed' ? labels.installed : sources.find(source => source.id === selectedSource)?.label ?? labels.title
  function selectSource(sourceId: SourceFilter) {
    onSelectSource(sourceId)
    setFiltersOpen(false)
  }
  const localSources = sources.filter((source) => !isRemoteSource(source))
  const remoteSources = sources.filter(isRemoteSource)

  return (
    <aside className="flex w-full shrink-0 flex-col border-b sm:h-full sm:w-[216px] sm:border-b-0 sm:border-r border-border/40 bg-background">
      <div className="border-b border-border/20 px-3 pb-3 pt-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="hidden text-xs font-semibold text-foreground sm:block">{labels.title}</h2>
          <Button size="sm" variant="ghost" className="min-w-0 justify-start sm:hidden" aria-label={labels.title} aria-expanded={filtersOpen} aria-controls={filtersId} onPress={() => setFiltersOpen(open => !open)}>
            <span className="truncate">{selectedLabel}</span><ChevronDown size={14} className={filtersOpen ? 'rotate-180' : ''} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            className="h-7 w-7 min-w-0 text-primary"
            onPress={onAddSource}
            aria-label={labels.addSource}
          >
            <Plus size={14} />
          </Button>
        </div>
      </div>

      <div id={filtersId} className={`${filtersOpen ? "block" : "hidden"} max-h-48 min-h-0 flex-1 overflow-y-auto px-2 py-2 sm:block sm:max-h-none`}>
        <p className="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
          {labels.quickFilters}
        </p>
        <FilterRow active={selectedSource === 'all'} label={labels.all} onClick={() => selectSource('all')} />
        <FilterRow
          active={selectedSource === 'installed'}
          label={labels.installed}
          onClick={() => selectSource('installed')}
        />

        {localSources.length > 0 ? (
          <SourceSection title={labels.localSources}>
            {localSources.map((source) => (
              <FilterRow
                key={source.id}
                active={selectedSource === source.id}
                label={source.label}
                hint={source.type}
                onClick={() => selectSource(source.id)}
              />
            ))}
          </SourceSection>
        ) : null}

        {remoteSources.length > 0 ? (
          <SourceSection title={labels.remoteSources}>
            {remoteSources.map((source) => (
              <RemoteSourceRow
                key={source.id}
                source={source}
                active={selectedSource === source.id}
                busy={busy === source.id}
                canRemove={!PROTECTED_SOURCE_IDS.has(source.id)}
                labels={{ sync: labels.syncSource, remove: labels.removeSource }}
                onSelect={() => selectSource(source.id)}
                onSync={() => onSyncSource(source.id)}
                onRemove={() => onRemoveSource(source.id)}
              />
            ))}
          </SourceSection>
        ) : null}
      </div>
    </aside>
  )
}

function SourceSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-3">
      <p className="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        {title}
      </p>
      {children}
    </div>
  )
}

function FilterRow({
  active,
  label,
  hint,
  onClick,
}: {
  active: boolean
  label: string
  hint?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mb-0.5 flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
        active
          ? 'bg-primary/10 font-medium text-primary'
          : 'text-foreground hover:bg-muted/40'
      }`}
    >
      <span className="truncate">{label}</span>
      {hint ? (
        <span className="ms-2 shrink-0 rounded bg-secondary/60 px-1 py-px text-[10px] uppercase text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </button>
  )
}

function RemoteSourceRow({
  source,
  active,
  busy,
  canRemove,
  labels,
  onSelect,
  onSync,
  onRemove,
}: {
  source: SkillSourceRecord
  active: boolean
  busy: boolean
  canRemove: boolean
  labels: { sync: string; remove: string }
  onSelect: () => void
  onSync: () => void
  onRemove: () => void
}) {
  return (
    <div
      className={`mb-1 rounded-lg border transition-colors ${
        active ? 'border-primary/30 bg-primary/5' : 'border-transparent hover:border-border/40 hover:bg-muted/20'
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full items-start gap-2 px-2.5 py-2 text-left"
      >
        <div className="min-w-0 flex-1">
          <p className={`truncate text-xs ${active ? 'font-medium text-primary' : 'text-foreground'}`}>
            {source.label}
          </p>
          {source.lastSyncError ? (
            <p className="mt-0.5 line-clamp-2 text-[11px] text-destructive">{source.lastSyncError}</p>
          ) : source.lastSyncAt ? (
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{source.lastSyncAt}</p>
          ) : (
            <p className="mt-0.5 text-[11px] text-muted-foreground/60">{source.type}</p>
          )}
        </div>
      </button>
      <div className="flex items-center justify-end gap-0.5 px-1.5 pb-1.5">
        <Button
          size="sm"
          variant="ghost"
          isIconOnly
          className="h-7 w-7 min-w-0"
          isDisabled={busy}
          onPress={onSync}
          aria-label={labels.sync}
        >
          <RefreshCw size={13} className={busy ? 'animate-spin' : ''} />
        </Button>
        {canRemove ? (
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            className="h-7 w-7 min-w-0 text-muted-foreground hover:text-destructive"
            isDisabled={busy}
            onPress={onRemove}
            aria-label={labels.remove}
          >
            <Trash2 size={13} />
          </Button>
        ) : null}
      </div>
    </div>
  )
}
