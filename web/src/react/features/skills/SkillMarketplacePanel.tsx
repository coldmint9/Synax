import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Button, Pagination, useOverlayState } from '@heroui/react'
import { RefreshCw, Search, Sparkles } from 'lucide-react'
import { skillsApi, skillSourcesApi, MARKET_PAGE_SIZE, type SkillSummary } from '../../../lib/api/skills'
import { useLocale } from '../../../hooks/useLocale'
import { SkillAddSourceModal, EMPTY_SOURCE_FORM } from './SkillAddSourceModal'
import { SkillCard } from './SkillCard'
import { SkillMarketSidebar, type SourceFilter } from './SkillMarketSidebar'

export function SkillMarketplacePanel() {
  const { t } = useLocale()
  const { projectId = '' } = useParams()
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
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newSource, setNewSource] = useState(EMPTY_SOURCE_FORM)
  const [createSourceError, setCreateSourceError] = useState<string | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 300)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    setPage(1)
  }, [debouncedQuery, selectedSource])

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const offset = (page - 1) * MARKET_PAGE_SIZE
      const [skillsRes, sourcesRes] = await Promise.all([
        skillsApi.list({
          projectId,
          q: debouncedQuery.trim() || undefined,
          sourceId: selectedSource !== 'all' && selectedSource !== 'installed' ? selectedSource : undefined,
          installedOnly: selectedSource === 'installed',
          limit: MARKET_PAGE_SIZE,
          offset,
        }),
        skillSourcesApi.list(),
      ])
      setSkills(skillsRes.items)
      setTotalSkills(skillsRes.total)
      setTotalExact(Boolean(skillsRes.totalExact))
      setHasMore(skillsRes.hasMore)
      setSources(sourcesRes.items)
      setError(null)
    } catch (err) {
      setSkills([])
      setTotalSkills(0)
      setTotalExact(false)
      setHasMore(false)
      setError(err instanceof Error ? err.message : 'Failed to load skills')
    } finally {
      setLoading(false)
    }
  }, [projectId, debouncedQuery, selectedSource, page])

  useEffect(() => {
    void reload()
  }, [reload])

  async function handleInstall(skill: SkillSummary) {
    setBusy(skill.id)
    try {
      await skillsApi.install({
        sourceId: skill.sourceId,
        name: skill.name,
        remoteUrl: skill.remoteUrl,
      })
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Install failed')
    } finally {
      setBusy(null)
    }
  }

  async function handleUninstall(skill: SkillSummary) {
    const targetId = skill.installed && skill.sourceKind === 'local' ? `local/${skill.name}` : skill.id
    setBusy(skill.id)
    try {
      await skillsApi.uninstall(targetId)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Uninstall failed')
    } finally {
      setBusy(null)
    }
  }

  async function handleSyncSource(sourceId?: string) {
    setBusy(sourceId ?? 'sync-all')
    try {
      if (sourceId) {
        await skillSourcesApi.sync(sourceId)
      } else {
        await skillsApi.sync()
      }
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed')
    } finally {
      setBusy(null)
    }
  }

  async function handleCreateSource() {
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
      await reload()
    } catch (err) {
      setCreateSourceError(err instanceof Error ? err.message : 'Failed to add source')
    } finally {
      setBusy(null)
    }
  }

  function handleOpenAddSource() {
    setNewSource(EMPTY_SOURCE_FORM)
    setCreateSourceError(null)
    addSourceModal.open()
  }

  async function handleRemoveSource(sourceId: string) {
    setBusy(sourceId)
    try {
      await skillSourcesApi.remove(sourceId)
      if (selectedSource === sourceId) setSelectedSource('all')
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove source')
    } finally {
      setBusy(null)
    }
  }

  const cardLabels = {
    install: t('skillMarketInstall'),
    uninstall: t('skillMarketUninstall'),
    installed: t('skillMarketInstalled'),
    available: t('skillMarketAvailable'),
  }

  const totalLabel = totalExact
    ? String(totalSkills)
    : hasMore
      ? `${totalSkills}+`
      : String(totalSkills)
  const totalPages = Math.max(1, Math.ceil(totalSkills / MARKET_PAGE_SIZE))
  const showPagination = !loading && skills.length > 0 && (page > 1 || hasMore || totalSkills > MARKET_PAGE_SIZE)

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden">
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
        onSelectSource={setSelectedSource}
        onAddSource={handleOpenAddSource}
        onSyncSource={(sourceId) => void handleSyncSource(sourceId)}
        onRemoveSource={(sourceId) => void handleRemoveSource(sourceId)}
      />

      <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background/50">
        <header className="shrink-0 border-b border-border/20 px-4 py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h1 className="text-sm font-semibold text-foreground">{t('skillMarketTitle')}</h1>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{t('skillMarketDesc')}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
                <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('skillMarketSearch')}
                  aria-label={t('skillMarketSearch')}
                  className="h-8 w-full rounded-md border border-border/30 bg-secondary/40 pl-7 pr-2.5 text-[11px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-accent/40 focus:bg-secondary/60"
                />
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
          <div className="shrink-0 border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-[11px] text-destructive">
            {error}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
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
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {Array.from({ length: 6 }, (_, index) => (
                <div
                  key={index}
                  className="h-[168px] animate-pulse rounded-xl border border-border/30 bg-secondary/20"
                />
              ))}
            </div>
          ) : skills.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-secondary/50 text-muted-foreground">
                <Sparkles size={20} />
              </div>
              <p className="mt-4 text-sm font-medium text-foreground">{t('skillMarketEmpty')}</p>
              <p className="mt-1 max-w-sm text-[11px] leading-relaxed text-muted-foreground">
                {t('skillMarketEmptyHint')}
              </p>
            </div>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {skills.map((skill) => (
                <li key={skill.id} className="min-h-[168px]">
                  <SkillCard
                    skill={skill}
                    busy={busy === skill.id}
                    labels={cardLabels}
                    onInstall={() => void handleInstall(skill)}
                    onUninstall={() => void handleUninstall(skill)}
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
                    <span className="px-2 text-[11px] text-muted-foreground">
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
