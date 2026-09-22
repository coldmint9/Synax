import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Button, Pagination, useOverlayState } from '@heroui/react'
import { RefreshCw, Search, Sparkles, X } from 'lucide-react'
import { skillsApi, skillSourcesApi, MARKET_PAGE_SIZE, type SkillSummary } from '../../../lib/api/skills'
import { useLocale } from '../../../hooks/useLocale'
import { SkillAddSourceModal, EMPTY_SOURCE_FORM } from './SkillAddSourceModal'
import { UninstallDialog } from '../../components/extensions/UninstallDialog'
import { SkillCard } from './SkillCard'
import { SkillMarketSidebar, type SourceFilter } from './SkillMarketSidebar'

export function SkillMarketplacePanel({ projectId: projectIdProp }: { projectId?: string } = {}) {
  const { t } = useLocale()
  const { projectId: routeProjectId = '' } = useParams()
  const projectId = projectIdProp ?? routeProjectId
  const addSourceModal = useOverlayState()
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [totalSkills, setTotalSkills] = useState(0)
  const [totalExact, setTotalExact] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [page, setPage] = useState(1)
  const [sources, setSources] = useState<Awaited<ReturnType<typeof skillSourcesApi.list>>['items']>([])
  const [selectedSource, setSelectedSource] = useState<SourceFilter>('all')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searchRevision, setSearchRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newSource, setNewSource] = useState(EMPTY_SOURCE_FORM)
  const [createSourceError, setCreateSourceError] = useState<string | null>(null)
  const [pendingUninstall, setPendingUninstall] = useState<SkillSummary | null>(null)
  const [uninstallError, setUninstallError] = useState<string | null>(null)
  const requestId = useRef(0)
  const previousQuery = useRef(query)
  const operationPending = useRef(false)
  const scopeKey = JSON.stringify([projectId, query, debouncedQuery, selectedSource, page, searchRevision])
  const currentScope = useRef(scopeKey)
  currentScope.current = scopeKey

  function changeQuery(value: string) {
    requestId.current += 1
    setLoading(true)
    setQuery(value)
  }

  function changeSource(value: SourceFilter) {
    if (value === selectedSource && page === 1) return
    requestId.current += 1
    setSelectedSource(value)
    setPage(1)
  }

  useEffect(() => {
    if (previousQuery.current === query) return
    previousQuery.current = query
    const timer = window.setTimeout(() => { setDebouncedQuery(query.trim()); setPage(1); setSearchRevision((revision) => revision + 1) }, 300)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    setPage(1)
  }, [projectId])

  const reload = useCallback(async () => {
    if (currentScope.current !== scopeKey || query.trim() !== debouncedQuery) return
    const id = ++requestId.current
    const isCurrent = () => id === requestId.current && currentScope.current === scopeKey
    setLoading(true)
    try {
      const offset = (page - 1) * MARKET_PAGE_SIZE
      const [skillsRes, sourcesRes] = await Promise.all([
        skillsApi.list({
          projectId,
          q: debouncedQuery.trim() || undefined,
          sourceId: selectedSource !== 'all' && selectedSource !== 'installed' ? selectedSource : undefined,
          installedOnly: selectedSource === 'installed',
          includeDisabled: true,
          limit: MARKET_PAGE_SIZE,
          offset,
        }),
        skillSourcesApi.list(),
      ])
      if (!isCurrent()) return
      setSkills(skillsRes.items)
      setTotalSkills(skillsRes.total)
      setTotalExact(Boolean(skillsRes.totalExact))
      setHasMore(skillsRes.hasMore)
      setSources(sourcesRes.items)
      setError(null)
    } catch (err) {
      if (!isCurrent()) return
      setSkills([])
      setTotalSkills(0)
      setTotalExact(false)
      setHasMore(false)
      setError(err instanceof Error ? err.message : 'Failed to load skills')
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [projectId, query, debouncedQuery, selectedSource, page, scopeKey])

  useEffect(() => {
    void reload()
    return () => { requestId.current += 1 }
  }, [reload])

  const refreshRef = useRef(reload)
  refreshRef.current = reload

  async function handleInstall(skill: SkillSummary) {
    if (operationPending.current) return
    operationPending.current = true
    setBusy(skill.id)
    try {
      await skillsApi.install({
        sourceId: skill.sourceId,
        name: skill.name,
        remoteUrl: skill.remoteUrl,
        version: skill.version || undefined,
      })
      await refreshRef.current()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Install failed')
    } finally {
      operationPending.current = false
      setBusy(null)
    }
  }

  async function handleUninstall(skill: SkillSummary) {
    if (!skill.installationId || operationPending.current) return
    operationPending.current = true
    const targetId = skill.installationId
    setUninstallError(null)
    setBusy(skill.id)
    try {
      await skillsApi.uninstall(targetId)
      setPendingUninstall(null)
      await refreshRef.current()
    } catch (err) {
      setUninstallError(err instanceof Error ? err.message : t('skillActionFailed'))
    } finally {
      operationPending.current = false
      setBusy(null)
    }
  }

  async function handleToggle(skill: SkillSummary, enabled: boolean) {
    if (operationPending.current) return
    operationPending.current = true
    setBusy(skill.id)
    try {
      await skillsApi.setEnabled(skill.installationId ?? skill.id, enabled, projectId)
      await refreshRef.current()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('skillActionFailed'))
    } finally {
      operationPending.current = false
      setBusy(null)
    }
  }

  async function handleSyncSource(sourceId?: string) {
    if (operationPending.current) return
    operationPending.current = true
    setBusy(sourceId ?? 'sync-all')
    try {
      if (sourceId) {
        await skillSourcesApi.sync(sourceId)
      } else {
        await skillsApi.sync()
      }
      await refreshRef.current()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed')
    } finally {
      operationPending.current = false
      setBusy(null)
    }
  }

  async function handleCreateSource() {
    if (operationPending.current) return
    operationPending.current = true
    setBusy('create-source')
    setCreateSourceError(null)
    try {
      await skillSourcesApi.create({
        id: newSource.id.trim(),
        label: newSource.label.trim(),
        type: newSource.type,
        config: newSource.type === 'git-index'
          ? { repo: newSource.repo.trim(), ref: 'main', indexPath: 'skills-index.json' }
          : { url: newSource.url.trim() },
      })
      addSourceModal.close()
      setNewSource(EMPTY_SOURCE_FORM)
      setCreateSourceError(null)
      await refreshRef.current()
    } catch (err) {
      setCreateSourceError(err instanceof Error ? err.message : 'Failed to add source')
    } finally {
      operationPending.current = false
      setBusy(null)
    }
  }

  function handleOpenAddSource() {
    setNewSource(EMPTY_SOURCE_FORM)
    setCreateSourceError(null)
    addSourceModal.open()
  }

  async function handleRemoveSource(sourceId: string) {
    if (operationPending.current) return
    operationPending.current = true
    setBusy(sourceId)
    try {
      await skillSourcesApi.remove(sourceId)
      if (selectedSource === sourceId) setSelectedSource('all')
      await refreshRef.current()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove source')
    } finally {
      operationPending.current = false
      setBusy(null)
    }
  }

  const totalLabel = totalExact
    ? String(totalSkills)
    : hasMore
      ? `${totalSkills}+`
      : String(totalSkills)
  const totalPages = Math.max(1, Math.ceil(totalSkills / MARKET_PAGE_SIZE))
  const showPagination = !loading && (page > 1 || hasMore || totalSkills > MARKET_PAGE_SIZE)

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden sm:flex-row">
      <SkillMarketSidebar
        sources={sources}
        selectedSource={selectedSource}
        busy={busy}
        labels={{
          title: t('skillSourcesTitle'),
          quickFilters: t('skillMarketQuickFilters'),
          all: t('skillMarketFilterAll'),
          installed: t('skillMarketFilterInstalled'),
          localSources: t('skillMarketLocalSources'),
          remoteSources: t('skillMarketRemoteSources'),
          addSource: t('skillSourceAdd'),
          syncSource: t('skillMarketSyncSource'),
          removeSource: t('skillMarketRemoveSource'),
        }}
        onSelectSource={changeSource}
        onAddSource={handleOpenAddSource}
        onSyncSource={(sourceId) => void handleSyncSource(sourceId)}
        onRemoveSource={(sourceId) => void handleRemoveSource(sourceId)}
      />

      <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background/50">
        <header className="shrink-0 border-b border-border/20 px-4 py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h1 className="text-sm font-semibold text-foreground">{t('skillMarketTitle')}</h1>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('skillMarketDesc')}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
                <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => changeQuery(e.target.value)}
                  placeholder={t('skillMarketSearch')}
                  aria-label={t('skillMarketSearch')}
                  className="h-9 w-full rounded-lg border border-border/40 bg-secondary/40 pl-8 pr-9 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-accent/40 focus:bg-secondary/60"
                />
                {query && <Button size="sm" variant="ghost" isIconOnly className="absolute right-0.5 top-0.5 size-8" aria-label={t('skillSearchClear')} onPress={() => changeQuery('')}><X size={14} /></Button>}
              </div>
              <Button
                size="sm"
                variant="secondary"
                className="shrink-0 gap-1.5"
                isDisabled={busy !== null}
                onPress={() => void handleSyncSource()}
              >
                <RefreshCw size={14} className={busy === 'sync-all' ? 'animate-spin' : ''} />
                <span className="hidden sm:inline">{t('skillMarketSyncAll')}</span>
              </Button>
            </div>
          </div>
        </header>

        {error ? (
          <div role="alert" className="shrink-0 border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive">
            {error.includes('at least 2 characters') ? t('skillSearchMinLength') : error}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-busy={loading}>
          <p className="mb-3 text-xs leading-5 text-muted-foreground">{t('skillMarketHint')}</p>
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {loading
                ? t('skillMarketLoading')
                : t('skillMarketSkillCountPaged', {
                    from: skills.length === 0 ? 0 : (page - 1) * MARKET_PAGE_SIZE + 1,
                    to: (page - 1) * MARKET_PAGE_SIZE + skills.length,
                    total: totalLabel,
                  })}
            </p>
          </div>

          {loading ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 6 }, (_, index) => (
                <div
                  key={index}
                  className="h-[76px] animate-pulse rounded-xl border border-border/30 bg-secondary/20"
                />
              ))}
            </div>
          ) : error && skills.length === 0 ? null : skills.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-secondary/50 text-muted-foreground">
                <Sparkles size={20} />
              </div>
              <p className="mt-4 text-sm font-medium text-foreground">{t(debouncedQuery ? 'skillSearchEmpty' : 'skillMarketEmpty')}</p>
              <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                {t(debouncedQuery ? 'skillSearchEmptyHint' : 'skillMarketEmptyHint')}
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {skills.map((skill) => (
                <li key={skill.id}>
                  <SkillCard
                    skill={skill}
                    busy={busy !== null}
                    pending={busy === skill.id}
                    onInstall={() => void handleInstall(skill)}
                    onUninstall={() => { setUninstallError(null); setPendingUninstall(skill) }}
                    onToggle={(enabled) => void handleToggle(skill, enabled)}
                  />
                </li>
              ))}
            </ul>
          )}

          {showPagination ? (
            <div className="mt-4 flex justify-center border-t border-border/20 pt-4">
              <Pagination>
                <Pagination.Content>
                  <Pagination.Item>
                    <Pagination.Previous
                      isDisabled={page <= 1 || busy !== null}
                      onPress={() => setPage((current) => Math.max(1, current - 1))}
                    >
                      <Pagination.PreviousIcon />
                      <span>{t('skillMarketPrevPage')}</span>
                    </Pagination.Previous>
                  </Pagination.Item>
                  <Pagination.Item>
                    <span className="px-2 text-xs text-muted-foreground">
                      {t('skillMarketPageIndicator', { page, total: hasMore ? `${totalPages}+` : String(totalPages) })}
                    </span>
                  </Pagination.Item>
                  <Pagination.Item>
                    <Pagination.Next
                      isDisabled={!hasMore || busy !== null}
                      onPress={() => setPage((current) => current + 1)}
                    >
                      <span>{t('skillMarketNextPage')}</span>
                      <Pagination.NextIcon />
                    </Pagination.Next>
                  </Pagination.Item>
                </Pagination.Content>
              </Pagination>
            </div>
          ) : null}
        </div>
      </section>

      <UninstallDialog name={pendingUninstall?.label ?? null} description={t('skillUninstallHint')}
        busy={busy !== null} error={uninstallError} onCancel={() => setPendingUninstall(null)}
        onConfirm={() => { if (pendingUninstall) void handleUninstall(pendingUninstall) }} />
      <SkillAddSourceModal
        state={addSourceModal}
        form={newSource}
        busy={busy === 'create-source'}
        error={createSourceError}
        labels={{
          title: t('skillSourceAddTitle'),
          type: t('skillSourceType'),
          typeGit: t('skillSourceTypeGit'),
          typeWellKnown: t('skillSourceTypeWellKnown'),
          id: t('skillSourceId'),
          idHint: t('skillSourceIdHint'),
          label: t('skillSourceLabel'),
          repo: t('skillSourceRepo'),
          repoHint: t('skillSourceRepoHint'),
          url: t('skillSourceUrl'),
          urlHint: t('skillSourceUrlHint'),
          cancel: t('commonCancel'),
          add: t('skillSourceAdd'),
          idRequired: t('skillSourceIdRequired'),
          idInvalid: t('skillSourceIdInvalid'),
          labelRequired: t('skillSourceLabelRequired'),
          repoRequired: t('skillSourceRepoRequired'),
          urlRequired: t('skillSourceUrlRequired'),
          urlInvalid: t('skillSourceUrlInvalid'),
        }}
        onChange={(patch) => setNewSource((prev) => ({ ...prev, ...patch }))}
        onSubmit={() => void handleCreateSource()}
      />
    </div>
  )
}
