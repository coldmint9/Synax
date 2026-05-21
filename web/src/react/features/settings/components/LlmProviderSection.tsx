import { useState, useCallback } from 'react'
import { KeyRound, Plus } from 'lucide-react'
import { SettingsSection } from './SettingsSection'
import { SaveIndicator } from './SaveIndicator'
import { LlmProviderCard } from './LlmProviderCard'
import { useAutoSave } from '../useAutoSave'
import {
  type ApiProviderDraft,
  API_PROVIDER_PRESETS,
  PRESET_BY_PROVIDER_ID,
  buildApiDrafts,
  createDraftFromPreset,
  createCustomDraft,
  draftToProviderDef,
  draftToConnection,
  isConfiguredProvider,
  upsertDraft,
} from '../lib/providerPresets'
import { configApi } from '../../../../lib/api/config'
import type { GlobalConfig, ProviderDef } from '../../../../lib/contracts/config'

interface LlmProviderSectionProps {
  config: GlobalConfig
  providers: ProviderDef[]
  onUpdate: (patch: Record<string, unknown>) => Promise<void>
  onReload: () => Promise<void>
}

export function LlmProviderSection({ config, providers, onUpdate, onReload }: LlmProviderSectionProps) {
  const [drafts, setDrafts] = useState(() => buildApiDrafts(config, providers))
  const [defaultId, setDefaultId] = useState(config.defaultApiProviderId)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showAddMenu, setShowAddMenu] = useState(false)

  const saveFn = useCallback(async (nextDrafts: ApiProviderDraft[]) => {
    const apiProviders = nextDrafts.map(draftToProviderDef)
    const connections = Object.fromEntries(nextDrafts.map(d => [d.id, draftToConnection(d)]))
    await onUpdate({
      providers: [...config.providers.filter(p => p.kind === 'acp'), ...apiProviders],
      providerConnections: connections,
      defaultApiProviderId: defaultId,
    })
  }, [config.providers, defaultId, onUpdate])

  const { save, saving, saved, error } = useAutoSave(saveFn, { debounceMs: 400 })

  const configuredDrafts = drafts.filter(isConfiguredProvider)

  const handleDraftChange = (updated: ApiProviderDraft) => {
    const next = drafts.map(d => d.id === updated.id ? updated : d)
    setDrafts(next)
    save(next)
  }

  const handleSetDefault = (draft: ApiProviderDraft) => {
    setDefaultId(draft.id)
    save(drafts)
  }

  const handleRemove = async (draft: ApiProviderDraft) => {
    const next = drafts.filter(d => d.id !== draft.id)
    setDrafts(next)
    if (defaultId === draft.id) {
      const newDefault = next.find(isConfiguredProvider)?.id ?? ''
      setDefaultId(newDefault)
    }
    save(next)
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
      setDrafts(prev => prev.map(d => d.id === draft.id ? { ...d, validating: false, validationMessage: result.ok ? '✓ 连接成功' : result.error || '连接失败' } : d))
    } catch {
      setDrafts(prev => prev.map(d => d.id === draft.id ? { ...d, validating: false, validationMessage: '验证请求失败' } : d))
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
        return { ...d, discoveringModels: false, models, modelMessage: result.ok ? `发现 ${result.models.length} 个模型` : (result.error || '发现失败') }
      }))
    } catch {
      setDrafts(prev => prev.map(d => d.id === draft.id ? { ...d, discoveringModels: false, modelMessage: '请求失败' } : d))
    }
  }

  const handleAddPreset = (preset: typeof API_PROVIDER_PRESETS[number]) => {
    const newDraft = createDraftFromPreset(preset)
    setDrafts(prev => upsertDraft(prev, newDraft))
    setExpandedId(newDraft.id)
    setShowAddMenu(false)
  }

  const handleAddCustom = () => {
    const newDraft = createCustomDraft(drafts)
    setDrafts(prev => [...prev, newDraft])
    setExpandedId(newDraft.id)
    setShowAddMenu(false)
  }

  return (
    <SettingsSection
      title="LLM Provider"
      icon={KeyRound}
      trailing={
        <div className="flex items-center gap-2">
          <SaveIndicator saving={saving} saved={saved} error={error} />
          <div className="relative">
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-muted"
              onClick={() => setShowAddMenu(!showAddMenu)}
            >
              <Plus size={12} />
              添加
            </button>
            {showAddMenu && (
              <div className="absolute right-0 top-full mt-1 z-10 w-48 rounded-lg border border-border bg-card p-1 shadow-lg">
                {API_PROVIDER_PRESETS.map(preset => (
                  <button
                    key={preset.providerId}
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-muted"
                    onClick={() => handleAddPreset(preset)}
                  >
                    {preset.label}
                  </button>
                ))}
                <div className="my-1 border-t border-border/50" />
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-muted"
                  onClick={handleAddCustom}
                >
                  自定义
                </button>
              </div>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-2">
        {configuredDrafts.length === 0 && !expandedId && (
          <p className="text-xs text-muted-foreground py-2">暂无已配置的 Provider，点击添加开始配置。</p>
        )}
        {drafts.filter(d => isConfiguredProvider(d) || d.id === expandedId).map(draft => (
          <LlmProviderCard
            key={draft.id}
            draft={draft}
            isDefault={draft.id === defaultId}
            expanded={expandedId === draft.id}
            onToggleExpand={() => setExpandedId(expandedId === draft.id ? null : draft.id)}
            onChange={handleDraftChange}
            onSetDefault={() => handleSetDefault(draft)}
            onRemove={() => void handleRemove(draft)}
            onValidate={() => void handleValidate(draft)}
            onDiscoverModels={() => void handleDiscoverModels(draft)}
          />
        ))}
      </div>
    </SettingsSection>
  )
}
