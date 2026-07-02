import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Button, useOverlayState } from '@heroui/react'
import { RefreshCw, Search, Sparkles } from 'lucide-react'
import { skillsApi, skillSourcesApi, type SkillSummary } from '../../../lib/api/skills'
import { useLocale } from '../../../hooks/useLocale'
import { SkillAddSourceModal } from './SkillAddSourceModal'
import { SkillCard } from './SkillCard'
import { SkillMarketSidebar, type SourceFilter } from './SkillMarketSidebar'

export function SkillMarketplacePanel() {
  const { t } = useLocale()
  const { projectId = '' } = useParams()
  const addSourceModal = useOverlayState()
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [sources, setSources] = useState<Awaited<ReturnType<typeof skillSourcesApi.list>>['items']>([])
  const [selectedSource, setSelectedSource] = useState<SourceFilter>('all')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newSource, setNewSource] = useState({
    id: '',
    label: '',
    type: 'git-index' as 'git-index' | 'well-known',
    repo: '',
    url: '',
  })

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 300)
    return () => window.clearTimeout(timer)
  }, [query])

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [skillsRes, sourcesRes] = await Promise.all([
        skillsApi.list({
          projectId,
          q: debouncedQuery.trim() || undefined,
          sourceId: selectedSource !== 'all' && selectedSource !== 'installed' ? selectedSource : undefined,
          installedOnly: selectedSource === 'installed',
        }),
        skillSourcesApi.list(),
      ])
      setSkills(skillsRes.items)
      setSources(sourcesRes.items)
      setError(null)
    } catch (err) {
      setSkills([])
      setError(err instanceof Error ? err.message : 'Failed to load skills')
    } finally {
      setLoading(false)
    }
  }, [projectId, debouncedQuery, selectedSource])

  useEffect(() => {
    void reload()
  }, [reload])

  async function handleInstall(skill: SkillSummary) {
    setBusy(skill.id)
    try {
      await skillsApi.install({ sourceId: skill.sourceId, name: skill.name })
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
      setNewSource({ id: '', label: '', type: 'git-index', repo: '', url: '' })
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add source')
    } finally {
      setBusy(null)
    }
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
        onAddSource={addSourceModal.open}
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
              {loading ? t('skillMarketLoading') : t('skillMarketSkillCount', { count: skills.length })}
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
        </div>
      </section>

      <SkillAddSourceModal
        state={addSourceModal}
        form={newSource}
        busy={busy === 'create-source'}
        labels={{
          title: t('skillSourceAddTitle'),
          id: t('skillSourceId'),
          label: t('skillSourceLabel'),
          wellKnown: t('skillSourceTypeWellKnown'),
          repo: t('skillSourceRepo'),
          url: t('skillSourceUrl'),
          cancel: t('commonCancel'),
          add: t('skillSourceAdd'),
        }}
        onChange={(patch) => setNewSource((prev) => ({ ...prev, ...patch }))}
        onSubmit={() => void handleCreateSource()}
      />
    </div>
  )
}
