import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertDialog, Button, Dropdown, Label } from '@heroui/react'
import { KeyRound, Plus } from 'lucide-react'
import { SettingsCard } from './SettingsCard'
import { SaveIndicator } from './SaveIndicator'
import { LlmProviderCard } from './LlmProviderCard'
import { LlmProviderModal } from './LlmProviderModal'
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
      : { providerId, baseUrl: current?.baseUrl, extra: current?.extra }
  }

  const providers = Array.from(providerMap.values())
  const patch: Record<string, unknown> = { providers, providerConnections }

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
  const [detailId, _setDetailId] = useState<string | null>(
    () => sessionStorage.getItem('llm-provider-expanded') || null,
  )
  const setDetailId = useCallback((id: string | null) => {
    _setDetailId(id)
    if (id) sessionStorage.setItem('llm-provider-expanded', id)
    else sessionStorage.removeItem('llm-provider-expanded')
  }, [])
  const [editingDraft, setEditingDraft] = useState<ApiProviderDraft | null>(null)
  const [pendingRemoveDraft, setPendingRemoveDraft] = useState<ApiProviderDraft | null>(null)
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
      config, next.drafts, next.defaultId, next.clearedProviderIds, next.providerIdsToPersist,
    ))
    markSaved()
  }, [config, markSaved, onUpdate])

  const configuredDrafts = drafts.filter(isConfiguredProvider)

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

  const handleRemove = async (draft: ApiProviderDraft) => {
    if (!hasStoredApiKey(config, draft.id)) {
      setDrafts(prev => prev.filter(d => d.id !== draft.id))
      setDetailId(null)
      return
    }
    const clearsBuiltin = isBuiltinApiProviderId(draft.id)
    const next = clearsBuiltin
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
    setDetailId(detailId === draft.id ? null : detailId)
    try {
      await saveProviderPatch({
        drafts: next,
        defaultId: nextDefaultId,
        clearedProviderIds: clearsBuiltin ? [draft.id] : undefined,
        providerIdsToPersist,
      })
      await onReload()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('llmProviderSaveFailed'))
    } finally {
      setSavingId(null)
    }
  }

  const handleModalSave = async (draft: ApiProviderDraft) => {
    const errors = validateProviderDraft(draft)
    if (errors.length > 0) return
    setSavingId(draft.id)
    setSaveError(null)
    try {
      const result = await configApi.validateAiApi({
        providerId: draft.apiKey.trim() ? undefined : draft.id,
        format: draft.format, baseUrl: draft.baseUrl,
        apiKey: draft.apiKey || undefined, model: draft.model,
      })
      if (!result.ok) throw new Error(result.error || t('llmProviderConnectFailed'))
      const resolvedDraft = result.resolvedBaseUrl ? { ...draft, baseUrl: result.resolvedBaseUrl } : draft
      const next = upsertDraft(drafts, resolvedDraft)
      const providerIdsToPersist = storedApiProviderIds(config)
      providerIdsToPersist.add(draft.id)
      await saveProviderPatch({ drafts: next, defaultId, providerIdsToPersist })
      setDrafts(next)
      setEditingDraft(null)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('llmProviderSaveFailed'))
      throw err
    } finally {
      setSavingId(null)
    }
  }

  const handleModalValidate = async (draft: ApiProviderDraft) => {
    const result = await configApi.validateAiApi({
      providerId: draft.apiKey.trim() ? undefined : draft.id,
      format: draft.format, baseUrl: draft.baseUrl,
      apiKey: draft.apiKey || undefined, model: draft.model,
    })
    if (!result.ok) throw new Error(result.error || t('llmProviderConnectFailed'))
  }

  const handleModalDiscover = async (draft: ApiProviderDraft): Promise<string[]> => {
    const result = await configApi.discoverAiModels({
      providerId: draft.apiKey.trim() ? undefined : draft.id,
      format: draft.format, baseUrl: draft.baseUrl,
      apiKey: draft.apiKey || undefined,
    })
    if (!result.ok) throw new Error(result.error || t('llmProviderDiscoverFailed'))
    return result.models
  }

  const handleAddPreset = (preset: typeof API_PROVIDER_PRESETS[number]) => {
    const existing = drafts.find(d => d.id === preset.providerId)
    if (existing) { setEditingDraft(existing); return }
    setEditingDraft(createDraftFromPreset(preset))
  }

  const handleAddCustom = () => {
    setEditingDraft(createCustomDraft(drafts))
  }

  return (
    <SettingsCard
      title="LLM Provider"
      icon={KeyRound}
      trailing={
        <div className="flex items-center gap-2">
          <SaveIndicator saving={Boolean(savingId)} saved={saved} error={saveError} />
          <Dropdown>
            <Button size="sm" variant="secondary" className="wh-pill-btn wh-pill-btn--soft wh-pill-btn--sm">
              <Plus size={12} />
              {t('llmProviderAdd')}
            </Button>
            <Dropdown.Popover>
              <Dropdown.Menu
                aria-label="Add provider"
                onAction={(key) => {
                  if (key === '__custom__') handleAddCustom()
                  else {
                    const preset = API_PROVIDER_PRESETS.find(p => p.providerId === key)
                    if (preset) handleAddPreset(preset)
                  }
                }}
              >
                {API_PROVIDER_PRESETS.map(preset => (
                  <Dropdown.Item key={preset.providerId} id={preset.providerId} textValue={preset.label}>
                    {preset.label}
                  </Dropdown.Item>
                ))}
                <Dropdown.Item key="__custom__" id="__custom__" textValue={t('llmProviderCustom')}>
                  {t('llmProviderCustom')}
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </div>
      }
    >
      <div className="space-y-2">
        {configuredDrafts.length === 0 && !editingDraft && (
          <p className="text-xs text-muted-foreground py-2">{t('llmProviderEmpty')}</p>
        )}
        {configuredDrafts.map(draft => (
          <LlmProviderCard
            key={draft.id}
            draft={draft}
            isDefault={draft.id === defaultId}
            isSaved={hasStoredApiKey(config, draft.id)}
            saving={savingId === draft.id}
            expanded={detailId === draft.id}
            onToggleExpand={() => setDetailId(detailId === draft.id ? null : draft.id)}
            onEdit={() => setEditingDraft(draft)}
            onSetDefault={() => void handleSetDefault(draft)}
            onRemove={() => setPendingRemoveDraft(draft)}
          />
        ))}
      </div>

      {editingDraft && (
        <LlmProviderModal
          draft={editingDraft}
          onClose={() => setEditingDraft(null)}
          onSave={handleModalSave}
          onValidate={handleModalValidate}
          onDiscoverModels={handleModalDiscover}
        />
      )}

      <AlertDialog.Backdrop
        isOpen={!!pendingRemoveDraft}
        onOpenChange={(open) => { if (!open) setPendingRemoveDraft(null) }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[400px]">
            <AlertDialog.CloseTrigger />
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>删除 {pendingRemoveDraft?.label}？</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>删除后该供应商的 API Key 和配置将被移除，此操作不可撤销。</p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary">取消</Button>
              <Button
                variant="danger"
                onPress={() => {
                  if (pendingRemoveDraft) {
                    void handleRemove(pendingRemoveDraft)
                    setPendingRemoveDraft(null)
                  }
                }}
              >
                删除
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </SettingsCard>
  )
}