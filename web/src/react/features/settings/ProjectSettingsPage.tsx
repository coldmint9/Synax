import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Check, RefreshCw, RotateCcw, Save, SlidersHorizontal } from 'lucide-react'
import { useConfig } from './useConfig'
import type { ProviderConnection } from '../../../lib/contracts/config'

type ProjectDraft = {
  providerId: string
  modelId: string
  baseUrl: string
  connectionMode: string
  runtime: string
  maxAgentsPerProject: string
  agentTimeoutSeconds: string
}

const emptyDraft: ProjectDraft = {
  providerId: '',
  modelId: '',
  baseUrl: '',
  connectionMode: '',
  runtime: '',
  maxAgentsPerProject: '',
  agentTimeoutSeconds: '',
}

export default function ProjectSettingsPage() {
  const { projectId = '' } = useParams()
  const {
    globalConfig,
    projectConfig,
    effectiveConfig,
    providers,
    loading,
    reload,
    updateProjectConfig,
    resetProjectConfig,
  } = useConfig(projectId)
  const [draft, setDraft] = useState<ProjectDraft>(emptyDraft)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const connection = projectConfig?.providerConnection
    setDraft({
      providerId: projectConfig?.providerId ?? '',
      modelId: projectConfig?.modelId ?? '',
      baseUrl: connection?.baseUrl ?? '',
      connectionMode: String(connection?.extra?.connectionMode ?? ''),
      runtime: String(connection?.extra?.runtime ?? ''),
      maxAgentsPerProject: projectConfig?.limits?.maxAgentsPerProject
        ? String(projectConfig.limits.maxAgentsPerProject)
        : '',
      agentTimeoutSeconds: projectConfig?.limits?.agentTimeoutMs
        ? String(Math.round(projectConfig.limits.agentTimeoutMs / 1000))
        : '',
    })
  }, [projectConfig])

  const selectedProviderId = draft.providerId || effectiveConfig?.providerId || globalConfig?.defaultProviderId || ''
  const acpProviders = useMemo(
    () => providers.filter((provider) => provider.kind === 'acp'),
    [providers],
  )
  const selectedProvider = useMemo(
    () => acpProviders.find((provider) => provider.id === selectedProviderId),
    [acpProviders, selectedProviderId],
  )
  const canOverrideConnection = Boolean(globalConfig?.features.allowProjectConnectionOverride)
  const hasConnectionOverride = Boolean(draft.baseUrl || draft.connectionMode || draft.runtime)

  const save = useCallback(async () => {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const connectionProviderId = draft.providerId || effectiveConfig?.providerId || globalConfig?.defaultProviderId || ''
      const providerConnection: ProviderConnection | null | undefined =
        canOverrideConnection && hasConnectionOverride && connectionProviderId
          ? {
              providerId: connectionProviderId,
              baseUrl: draft.baseUrl || undefined,
              extra: {
                kind: 'acp',
                connectionMode: draft.connectionMode || undefined,
                runtime: draft.runtime || undefined,
              },
            }
          : projectConfig?.providerConnection
            ? null
            : undefined

      await updateProjectConfig({
        providerId: draft.providerId || null,
        modelId: draft.modelId || null,
        ...(providerConnection !== undefined ? { providerConnection } : {}),
        limits: {
          ...(draft.maxAgentsPerProject ? { maxAgentsPerProject: Number(draft.maxAgentsPerProject) } : {}),
          ...(draft.agentTimeoutSeconds ? { agentTimeoutMs: Number(draft.agentTimeoutSeconds) * 1000 } : {}),
        },
      })
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1800)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [
    canOverrideConnection,
    draft,
    effectiveConfig?.providerId,
    globalConfig?.defaultProviderId,
    hasConnectionOverride,
    projectConfig?.providerConnection,
    updateProjectConfig,
  ])

  const reset = useCallback(async () => {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      await resetProjectConfig()
      setDraft(emptyDraft)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1800)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed')
    } finally {
      setSaving(false)
    }
  }, [resetProjectConfig])

  if (!projectId) return <div className="p-6 text-sm text-destructive">Missing project ID</div>

  return (
    <div className="h-full overflow-auto bg-background">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <Link
          to={'/projects/' + projectId + '/wiki'}
          className="mb-6 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition hover:text-foreground"
        >
          <ArrowLeft size={14} />
          Back to project
        </Link>

        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Project Settings</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              <span className="font-mono text-foreground">{projectId}</span> overrides ACP connection and limits for this project only. Precedence is Project {'>'} Global.
            </p>
          </div>
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
            onClick={reload}
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>

        {loading ? (
          <p className="mt-8 text-sm text-muted-foreground">Loading...</p>
        ) : (
          <div className="mt-6 space-y-4">
            <section className="rounded-lg border border-border/60 bg-card p-4">
              <div className="flex items-center gap-2">
                <SlidersHorizontal size={16} className="text-muted-foreground" />
                <h2 className="text-sm font-semibold">Effective Config</h2>
              </div>
              {effectiveConfig ? (
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <Metric label="ACP Provider" value={effectiveConfig.provider.label} />
                  <Metric label="ACP Model" value={effectiveConfig.model.label} />
                  <Metric label="Agent Timeout" value={String(Math.round(effectiveConfig.limits.agentTimeoutMs / 1000)) + 's'} />
                </div>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">No effective config</p>
              )}
            </section>

            <section className="rounded-lg border border-border/60 bg-card p-4">
              <h2 className="text-sm font-semibold">ACP Provider Override</h2>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  ACP Provider
                  <select
                    className="mt-1 h-10 w-full rounded-md border border-border bg-background px-3"
                    value={draft.providerId}
                    onChange={(event) => setDraft((value) => ({ ...value, providerId: event.target.value, modelId: '' }))}
                  >
                    <option value="">Inherit global default ({globalConfig?.defaultProviderId ?? 'unset'})</option>
                    {acpProviders.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  Model
                  <select
                    className="mt-1 h-10 w-full rounded-md border border-border bg-background px-3"
                    value={draft.modelId}
                    onChange={(event) => setDraft((value) => ({ ...value, modelId: event.target.value }))}
                  >
                    <option value="">Use provider default</option>
                    {selectedProvider?.models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </section>

            <section className="rounded-lg border border-border/60 bg-card p-4">
              <h2 className="text-sm font-semibold">ACP Connection Override</h2>
              {!canOverrideConnection ? (
                <p className="mt-3 rounded-md border border-border/50 bg-secondary/30 p-3 text-sm text-muted-foreground">
                  Global settings do not allow project-level ACP connection overrides.
                </p>
              ) : (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="text-sm">
                    Base URL
                    <input
                      className="mt-1 h-10 w-full rounded-md border border-border bg-background px-3"
                      value={draft.baseUrl}
                      onChange={(event) => setDraft((value) => ({ ...value, baseUrl: event.target.value }))}
                      placeholder={effectiveConfig?.connection.baseUrl || 'Inherit global'}
                    />
                  </label>
                  <label className="text-sm">
                    Connection Mode
                    <select
                      className="mt-1 h-10 w-full rounded-md border border-border bg-background px-3"
                      value={draft.connectionMode}
                      onChange={(event) => setDraft((value) => ({ ...value, connectionMode: event.target.value }))}
                    >
                      <option value="">Inherit global</option>
                      <option value="local">local</option>
                      <option value="remote">remote</option>
                    </select>
                  </label>
                  <label className="text-sm">
                    Runtime
                    <select
                      className="mt-1 h-10 w-full rounded-md border border-border bg-background px-3"
                      value={draft.runtime}
                      onChange={(event) => setDraft((value) => ({ ...value, runtime: event.target.value }))}
                    >
                      <option value="">Inherit global</option>
                      <option value="node">Node</option>
                      <option value="python">Python</option>
                    </select>
                  </label>
                </div>
              )}
            </section>

            <section className="rounded-lg border border-border/60 bg-card p-4">
              <h2 className="text-sm font-semibold">Limits Override</h2>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  Max Agents Per Project
                  <input
                    type="number"
                    min={1}
                    className="mt-1 h-10 w-full rounded-md border border-border bg-background px-3"
                    value={draft.maxAgentsPerProject}
                    onChange={(event) => setDraft((value) => ({ ...value, maxAgentsPerProject: event.target.value }))}
                    placeholder={String(globalConfig?.limits.maxAgentsPerProject ?? '')}
                  />
                </label>
                <label className="text-sm">
                  Agent Timeout Seconds
                  <input
                    type="number"
                    min={1}
                    className="mt-1 h-10 w-full rounded-md border border-border bg-background px-3"
                    value={draft.agentTimeoutSeconds}
                    onChange={(event) => setDraft((value) => ({ ...value, agentTimeoutSeconds: event.target.value }))}
                    placeholder={globalConfig ? String(Math.round(globalConfig.limits.agentTimeoutMs / 1000)) : ''}
                  />
                </label>
              </div>
            </section>

            <div className="flex flex-wrap items-center gap-3">
              <button
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs text-primary-foreground disabled:opacity-50"
                disabled={saving}
                onClick={save}
              >
                <Save size={14} />
                {saving ? 'Saving...' : 'Save Project Overrides'}
              </button>
              <button
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-4 py-2 text-xs text-foreground hover:bg-secondary disabled:opacity-50"
                disabled={saving || !projectConfig}
                onClick={reset}
              >
                <RotateCcw size={14} />
                Reset To Global
              </button>
              {saved && (
                <span className="inline-flex items-center gap-1 text-xs text-success">
                  <Check size={14} />
                  Saved
                </span>
              )}
              {error && <span className="text-xs text-destructive">{error}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/50 bg-background/40 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-medium">{value}</div>
    </div>
  )
}
