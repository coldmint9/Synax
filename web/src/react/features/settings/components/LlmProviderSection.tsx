import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Dropdown, Label } from '@heroui/react'
import { KeyRound, Plus } from 'lucide-react'
import { SettingsCard } from './SettingsCard'
import { SaveIndicator } from './SaveIndicator'
import { LlmProviderCard } from './LlmProviderCard'
import { useLocale } from '../../../../hooks/useLocale'
import {
  type ApiProviderDraft,
  API_PROVIDER_PRESETS,
  buildApiDrafts,
  createDraftFromPreset,
  createCustomDraft,
  draftToProviderDef,
  draftToConnection,
  isBuiltinApiProviderId,
  isConfiguredProvider,
  upsertDraft,
} from '../lib/providerPresets'
import { validateProviderDraft } from '../lib/validation'
import { configApi } from '../../../../lib/api/config'
import type { GlobalConfig, ProviderDef } from '../../../../lib/contracts/config'

interface LlmProviderSectionProps {
  config: GlobalConfig
  providers: ProviderDef[]
  onUpdate: (patch: Record<string, unknown>) => Promise<void>
  onReload: () => Promise<void>
}

type LlmProviderSaveState = {
  drafts: ApiProviderDraft[]
  defaultId: string
  clearedProviderIds?: string[]
  providerIdsToPersist: Set<string>
}

function isOfficialProvider(provider: ProviderDef): boolean {
  return provider.kind === 'acp' || isBuiltinApiProviderId(provider.id)
}

function hasStoredApiKey(config: GlobalConfig, providerId: string): boolean {
  const connection = config.providerConnections[providerId]
  return Boolean(connection?.apiKey?.trim() || connection?.apiKeyMasked?.trim())
}

function storedApiProviderIds(config: GlobalConfig): Set<string> {
  return new Set(
    config.providers
      .filter(provider => provider.kind === 'api' && hasStoredApiKey(config, provider.id))
      .map(provider => provider.id),
  )
}

function buildApiProviderPatch(
  config: GlobalConfig,
  nextDrafts: ApiProviderDraft[],
  nextDefaultId: string,
  clearedProviderIds: string[] = [],
  providerIdsToPersist = storedApiProviderIds(config),
): Record<string, unknown> {
  const configuredDrafts = nextDrafts.filter(draft => providerIdsToPersist.has(draft.id) && isConfiguredProvider(draft))
  const configuredIds = new Set(configuredDrafts.map(d => d.id))
  const nextDraftById = new Map(nextDrafts.map(d => [d.id, d]))
  const providerMap = new Map<string, ProviderDef>()

  for (const provider of config.providers) {
    if (isOfficialProvider(provider)) providerMap.set(provider.id, provider)
  }
  for (const draft of configuredDrafts) {
    providerMap.set(draft.id, draftToProviderDef(draft))
  }

  const providerConnections = Object.fromEntries(
    configuredDrafts.map(draft => [draft.id, draftToConnection(draft)]),
  )

  for (const providerId of clearedProviderIds) {
    if (!isBuiltinApiProviderId(providerId) || configuredIds.has(providerId)) continue
    const draft = nextDraftById.get(providerId)
    const current = config.providerConnections[providerId]
    if (!draft && !current) continue
    providerConnections[providerId] = draft
      ? draftToConnection({ ...draft, apiKey: '', apiKeyMasked: '' })
      : {
          providerId,
          baseUrl: current?.baseUrl,
          extra: current?.extra,
        }
  }

  const providers = Array.from(providerMap.values())
  const patch: Record<string, unknown> = {
    providers,
    providerConnections,
  }

  const defaultExists = providers.some(provider => provider.kind === 'api' && provider.id === nextDefaultId)
  if (nextDefaultId && nextDefaultId !== config.defaultApiProviderId && defaultExists) {
    patch.defaultApiProviderId = nextDefaultId
  }

  return patch
}

export function LlmProviderSection({ config, providers, onUpdate, onReload }: LlmProviderSectionProps) {
  const { t } = useLocale()
  const [drafts, setDrafts] = useState(() => buildApiDrafts(config, providers))
  const [defaultId, setDefaultId] = useState(config.defaultApiProviderId)
  const [expandedId, _setExpandedId] = useState<string | null>(
    () => sessionStorage.getItem('llm-provider-expanded') || null,
  )
  const setExpandedId = useCallback((id: string | null) => {
    _setExpandedId(id)
    if (id) sessionStorage.setItem('llm-provider-expanded', id)
    else sessionStorage.removeItem('llm-provider-expanded')
  }, [])
  const [savingId, setSavingId] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setDrafts(buildApiDrafts(config, providers))
    setDefaultId(config.defaultApiProviderId)
  }, [config, providers])

  useEffect(() => () => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
  }, [])

  const markSaved = useCallback(() => {
    setSaved(true)
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    savedTimerRef.current = setTimeout(() => setSaved(false), 1500)
  }, [])

  const saveProviderPatch = useCallback(async (next: LlmProviderSaveState) => {
    await onUpdate(buildApiProviderPatch(
      config,
      next.drafts,
      next.defaultId,
      next.clearedProviderIds,
      next.providerIdsToPersist,
    ))
    markSaved()
  }, [config, markSaved, onUpdate])

  const configuredDrafts = drafts.filter(isConfiguredProvider)

  const handleDraftChange = (updated: ApiProviderDraft) => {
    const next = drafts.map(d => d.id === updated.id ? updated : d)
    setDrafts(next)
  }

  const handleSetDefault = async (draft: ApiProviderDraft) => {
    if (!hasStoredApiKey(config, draft.id)) return
    setSavingId(draft.id)
    setSaveError(null)
    try {
      await onUpdate({ defaultApiProviderId: draft.id })
      setDefaultId(draft.id)
      markSaved()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('llmProviderSaveFailed'))
    } finally {
      setSavingId(null)
    }
  }

  const discardDraft = (draft: ApiProviderDraft) => {
    if (isBuiltinApiProviderId(draft.id)) {
      setDrafts(prev => prev.map(d => d.id === draft.id ? { ...d, apiKey: '', apiKeyMasked: '' } : d))
    } else {
      setDrafts(prev => prev.filter(d => d.id !== draft.id))
    }
    setExpandedId(null)
  }

  const handleSave = async (draft: ApiProviderDraft) => {
    const errors = validateProviderDraft(draft)
    if (errors.length > 0) {
      setDrafts(prev => prev.map(d => d.id === draft.id ? { ...d, validationMessage: errors[0].message } : d))
      return
    }

    setSavingId(draft.id)
    setSaveError(null)
    setDrafts(prev => prev.map(d => d.id === draft.id ? { ...d, validating: true, validationMessage: null } : d))
    try {
      const result = await configApi.validateAiApi({
        providerId: draft.apiKey.trim() ? undefined : draft.id,
        format: draft.format,
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey || undefined,
        model: draft.model,
      })

      if (!result.ok) {
        setDrafts(prev => prev.map(d => d.id === draft.id ? {
          ...d,
          validating: false,
          validationMessage: result.error || t('llmProviderConnectFailed'),
        } : d))
        return
      }

      const resolvedDraft = result.resolvedBaseUrl ? { ...draft, baseUrl: result.resolvedBaseUrl } : draft
      const next = drafts.map(d => d.id === draft.id ? resolvedDraft : d)
      const providerIdsToPersist = storedApiProviderIds(config)
      providerIdsToPersist.add(draft.id)
      await saveProviderPatch({ drafts: next, defaultId, providerIdsToPersist })
      setDrafts(prev => prev.map(d => d.id === draft.id ? {
        ...d,
        ...(result.resolvedBaseUrl ? { baseUrl: result.resolvedBaseUrl } : {}),
        validating: false,
        validationMessage: t('llmProviderSaveSuccess'),
      } : d))
    } catch (err) {
      const message = err instanceof Error ? err.message : t('llmProviderSaveFailed')
      setSaveError(message)
      setDrafts(prev => prev.map(d => d.id === draft.id ? { ...d, validating: false, validationMessage: message } : d))
    } finally {
      setSavingId(null)
    }
  }

  const handleToggleDraft = (draft: ApiProviderDraft) => {
    if (expandedId !== draft.id) {
      setExpandedId(draft.id)
      return
    }

    if (!hasStoredApiKey(config, draft.id)) {
      discardDraft(draft)
      return
    }

    setExpandedId(null)
  }

  const handleRemove = async (draft: ApiProviderDraft) => {
    if (!hasStoredApiKey(config, draft.id)) {
      discardDraft(draft)
      return
    }

    const clearsBuiltinConnection = isBuiltinApiProviderId(draft.id)
    const next = clearsBuiltinConnection
      ? drafts.map(d => d.id === draft.id ? { ...d, apiKey: '', apiKeyMasked: '' } : d)
      : drafts.filter(d => d.id !== draft.id)
    const nextConfigured = next.filter(isConfiguredProvider)
    const nextDefaultId = defaultId === draft.id
      ? nextConfigured[0]?.id ?? config.providers.find(p => p.kind === 'api')?.id ?? 'openai'
      : defaultId
    const providerIdsToPersist = storedApiProviderIds(config)
    providerIdsToPersist.delete(draft.id)

    setSavingId(draft.id)
    setSaveError(null)
    setDrafts(next)
    setDefaultId(nextDefaultId)
    setExpandedId(expandedId === draft.id ? null : expandedId)
    try {
      await saveProviderPatch({
        drafts: next,
        defaultId: nextDefaultId,
        clearedProviderIds: clearsBuiltinConnection ? [draft.id] : undefined,
        providerIdsToPersist,
      })
      setDefaultId(nextDefaultId)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('llmProviderSaveFailed'))
    } finally {
      setSavingId(null)
    }
  }

  const handleValidate = async (draft: ApiProviderDraft) => {
    setDrafts(prev => prev.map(d => d.id === draft.id ? { ...d, validating: true, validationMessage: null } : d))
    try {
      const result = await configApi.validateAiApi({
        providerId: draft.apiKey.trim() ? undefined : draft.id,
        format: draft.format,
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey || undefined,
        model: draft.model,
      })
      setDrafts(prev => prev.map(d => d.id === draft.id ? {
        ...d,
        ...(result.resolvedBaseUrl ? { baseUrl: result.resolvedBaseUrl } : {}),
        validating: false,
        validationMessage: result.ok ? t('llmProviderSaveSuccess') : result.error || t('llmProviderConnectFailed'),
      } : d))
    } catch {
      setDrafts(prev => prev.map(d => d.id === draft.id ? { ...d, validating: false, validationMessage: t('llmProviderRequestFailed') } : d))
    }
  }

  const handleDiscoverModels = async (draft: ApiProviderDraft) => {
    setDrafts(prev => prev.map(d => d.id === draft.id ? { ...d, discoveringModels: true, modelMessage: null } : d))
    try {
      const result = await configApi.discoverAiModels({
        providerId: draft.apiKey.trim() ? undefined : draft.id,
        format: draft.format,
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey || undefined,
      })
      setDrafts(prev => prev.map(d => {
        if (d.id !== draft.id) return d
        const models = result.ok && result.models.length > 0 ? result.models : d.models
        return {
          ...d,
          ...(result.resolvedBaseUrl ? { baseUrl: result.resolvedBaseUrl } : {}),
          discoveringModels: false,
          models,
          modelMessage: result.ok ? t('llmProviderDiscoverCount', { count: result.models.length }) : (result.error || t('llmProviderDiscoverFailed')),
        }
      }))
    } catch {
      setDrafts(prev => prev.map(d => d.id === draft.id ? { ...d, discoveringModels: false, modelMessage: t('llmProviderRequestFailed') } : d))
    }
  }

  const handleAddPreset = (preset: typeof API_PROVIDER_PRESETS[number]) => {
    const existing = drafts.find(d => d.id === preset.providerId)
    if (existing) {
      setExpandedId(existing.id)
      return
    }

    const newDraft = createDraftFromPreset(preset)
    setDrafts(prev => upsertDraft(prev, newDraft))
    setExpandedId(newDraft.id)
  }

  const handleAddCustom = () => {
    const newDraft = createCustomDraft(drafts)
    setDrafts(prev => [...prev, newDraft])
    setExpandedId(newDraft.id)
  }

  return (
    <SettingsCard
      title="LLM Provider"
      icon={KeyRound}
      trailing={
        <div className="flex items-center gap-2">
          <SaveIndicator saving={Boolean(savingId)} saved={saved} error={saveError} />
          <Dropdown>
            <Button size="sm" variant="bordered" startContent={<Plus size={12} />}>
              {t('llmProviderAdd')}
            </Button>
            <Dropdown.Popover>
              <Dropdown.Menu
                aria-label="Add provider"
                onAction={(key) => {
                  if (key === '__custom__') {
                    handleAddCustom()
                  } else {
                    const preset = API_PROVIDER_PRESETS.find(p => p.providerId === key)
                    if (preset) handleAddPreset(preset)
                  }
                }}
              >
                {[
                  ...API_PROVIDER_PRESETS.map(preset => (
                    <Dropdown.Item key={preset.providerId} id={preset.providerId} textValue={preset.label}>
                      <Label>{preset.label}</Label>
                    </Dropdown.Item>
                  )),
                  <Dropdown.Item key="__custom__" id="__custom__" textValue="Custom">
                    <Label>{t('llmProviderCustom')}</Label>
                  </Dropdown.Item>,
                ]}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </div>
      }
    >
      <div className="space-y-2">
        {configuredDrafts.length === 0 && !expandedId && (
          <p className="text-xs text-muted-foreground py-2">{t('llmProviderEmpty')}</p>
        )}
        {drafts.filter(d => isConfiguredProvider(d) || d.id === expandedId).map(draft => (
          <LlmProviderCard
            key={draft.id}
            draft={draft}
            isDefault={draft.id === defaultId}
            isSaved={hasStoredApiKey(config, draft.id)}
            saving={savingId === draft.id}
            expanded={expandedId === draft.id}
            onToggleExpand={() => handleToggleDraft(draft)}
            onChange={handleDraftChange}
            onSave={() => void handleSave(draft)}
            onSetDefault={() => void handleSetDefault(draft)}
            onRemove={() => void handleRemove(draft)}
            onValidate={() => void handleValidate(draft)}
            onDiscoverModels={() => void handleDiscoverModels(draft)}
          />
        ))}
      </div>
    </SettingsCard>
  )
}
