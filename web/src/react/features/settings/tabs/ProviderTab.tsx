import { useState, useCallback, useMemo } from 'react'
import { Card, Input, NumberField } from '@heroui/react'
import type { ProjectSettings } from '../../../../lib/contracts/project-settings'
import type { GlobalConfig, ProviderDef } from '../../../../lib/contracts/config'
import { useLocale } from '../../../../hooks/useLocale'
import { SettingsSelect } from '../components/SettingsSelect'
import { SaveFooter } from '../components/SaveFooter'

interface ProviderTabProps {
  settings: ProjectSettings
  globalConfig: GlobalConfig | null
  providers: ProviderDef[]
  onSave: (data: ProjectSettings['provider']) => Promise<ProjectSettings>
}

export function ProviderTab({ settings, globalConfig, providers, onSave }: ProviderTabProps) {
  const { t } = useLocale()
  const [draft, setDraft] = useState({
    providerId: settings.provider.providerId ?? '',
    modelId: settings.provider.modelId ?? '',
    baseUrl: settings.provider.providerConnection?.baseUrl ?? '',
    connectionMode: String(settings.provider.providerConnection?.extra?.connectionMode ?? ''),
    runtime: String(settings.provider.providerConnection?.extra?.runtime ?? ''),
    maxAgentsPerProject: settings.provider.limits?.maxAgentsPerProject ? String(settings.provider.limits.maxAgentsPerProject) : '',
    agentTimeoutSeconds: settings.provider.limits?.agentTimeoutMs ? String(Math.round(settings.provider.limits.agentTimeoutMs / 1000)) : '',
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const acpProviders = useMemo(() => providers.filter(p => p.kind === 'acp'), [providers])
  const selectedProvider = useMemo(
    () => acpProviders.find(p => p.id === (draft.providerId || globalConfig?.defaultProviderId)),
    [acpProviders, draft.providerId, globalConfig?.defaultProviderId],
  )

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const hasConnection = draft.baseUrl || draft.connectionMode || draft.runtime
      await onSave({
        providerId: draft.providerId || null,
        modelId: draft.modelId || null,
        providerConnection: hasConnection ? {
          providerId: draft.providerId || globalConfig?.defaultProviderId || '',
          baseUrl: draft.baseUrl || undefined,
          extra: { kind: 'acp', connectionMode: draft.connectionMode || undefined, runtime: draft.runtime || undefined },
        } : null,
        limits: {
          ...(draft.maxAgentsPerProject ? { maxAgentsPerProject: Number(draft.maxAgentsPerProject) } : {}),
          ...(draft.agentTimeoutSeconds ? { agentTimeoutMs: Number(draft.agentTimeoutSeconds) * 1000 } : {}),
        },
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 1800)
    } finally {
      setSaving(false)
    }
  }, [draft, globalConfig?.defaultProviderId, onSave])

  return (
    <div className="mt-4 space-y-4">
      <Card variant="secondary">
        <Card.Header>
          <span className="text-xs font-semibold">{t('providerAcpOverride')}</span>
        </Card.Header>
        <Card.Content>
          <div className="grid gap-3 sm:grid-cols-2">
            <SettingsSelect
              label="Provider"
              selectedKeys={[draft.providerId]}
              onSelectionChange={(keys) => {
                const val = [...keys][0] as string ?? ''
                setDraft(d => ({ ...d, providerId: val, modelId: '' }))
              }}
              aria-label="Provider"
              options={[
                { key: '', label: t('providerInheritGlobal', { id: globalConfig?.defaultProviderId ?? '' }) },
                ...acpProviders.map(p => ({ key: p.id, label: p.label })),
              ]}
            />
            <SettingsSelect
              label="Model"
              selectedKeys={[draft.modelId]}
              onSelectionChange={(keys) => {
                const val = [...keys][0] as string ?? ''
                setDraft(d => ({ ...d, modelId: val }))
              }}
              aria-label="Model"
              options={[
                { key: '', label: t('providerUseDefault') },
                ...(selectedProvider?.models ?? []).map(m => ({ key: m.id, label: m.label })),
              ]}
            />
          </div>
        </Card.Content>
      </Card>

      <Card variant="secondary">
        <Card.Header>
          <span className="text-xs font-semibold">{t('providerConnectionOverride')}</span>
        </Card.Header>
        <Card.Content>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              size="sm"
              variant="bordered"
              label="Base URL"
              labelPlacement="outside"
              value={draft.baseUrl}
              onValueChange={(val) => setDraft(d => ({ ...d, baseUrl: val }))}
              placeholder={t('providerInheritGlobalPlaceholder')}
            />
            <SettingsSelect
              label="Connection Mode"
              selectedKeys={[draft.connectionMode]}
              onSelectionChange={(keys) => {
                const val = [...keys][0] as string ?? ''
                setDraft(d => ({ ...d, connectionMode: val }))
              }}
              aria-label="Connection Mode"
              options={[
                { key: '', label: t('providerInheritGlobalPlaceholder') },
                { key: 'local', label: 'local' },
                { key: 'remote', label: 'remote' },
              ]}
            />
          </div>
        </Card.Content>
      </Card>

      <Card variant="secondary">
        <Card.Header>
          <span className="text-xs font-semibold">{t('providerLimitsOverride')}</span>
        </Card.Header>
        <Card.Content>
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField
              size="sm"
              variant="bordered"
              value={draft.maxAgentsPerProject}
              onChange={(val) => setDraft(d => ({ ...d, maxAgentsPerProject: val }))}
              minValue={1}
            >
              <label className="text-xs text-foreground">{t('providerMaxAgents')}</label>
              <NumberField.Group>
                <NumberField.Input />
              </NumberField.Group>
            </NumberField>
            <NumberField
              size="sm"
              variant="bordered"
              value={draft.agentTimeoutSeconds}
              onChange={(val) => setDraft(d => ({ ...d, agentTimeoutSeconds: val }))}
              minValue={1}
            >
              <label className="text-xs text-foreground">{t('providerTimeout')}</label>
              <NumberField.Group>
                <NumberField.Input />
              </NumberField.Group>
            </NumberField>
          </div>
        </Card.Content>
      </Card>

      <SaveFooter saving={saving} saved={saved} onSave={handleSave} />
    </div>
  )
}