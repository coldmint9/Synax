import { useState, useCallback, useEffect } from 'react'
import { Button, Checkbox, Chip } from '@heroui/react'
import { Server, RefreshCw } from 'lucide-react'
import { SettingsCard } from './SettingsCard'
import { SaveIndicator } from './SaveIndicator'
import { useAutoSave } from '../useAutoSave'
import { configApi } from '../../../../lib/api/config'
import type { AcpDiscoveryItem, GlobalConfig } from '../../../../lib/contracts/config'
import { useLocale } from '../../../../hooks/useLocale'

interface AcpSectionProps {
  config: GlobalConfig
  onUpdate: (patch: Record<string, unknown>) => Promise<void>
  onReload: () => Promise<void>
}

const statusColor = (s: AcpDiscoveryItem['status']): 'success' | 'accent' | 'default' | 'danger' => {
  switch (s) {
    case 'available': return 'success'
    case 'installed': return 'accent'
    case 'missing': return 'default'
    case 'failed': return 'danger'
  }
}

export function AcpSection({ config, onUpdate }: AcpSectionProps) {
  const { t } = useLocale()
  const [enabledIds, setEnabledIds] = useState<string[]>(config.enabledAcpProviderIds ?? [config.defaultProviderId])
  const [discovery, setDiscovery] = useState<AcpDiscoveryItem[]>([])
  const [discovering, setDiscovering] = useState(false)

  const saveFn = useCallback(async (ids: string[]) => {
    await configApi.updateGlobal({ enabledAcpProviderIds: ids, defaultProviderId: ids[0] || config.defaultProviderId })
  }, [config.defaultProviderId])

  const { saveImmediate, saving, saved, error } = useAutoSave(saveFn)

  const loadDiscovery = async () => {
    setDiscovering(true)
    try {
      const result = await configApi.discoverAcp()
      setDiscovery(prev => {
        if (prev.length === 0) return result.supported
        return result.supported.map(item => {
          const existing = prev.find(p => p.id === item.id)
          return existing ? { ...existing, status: item.status, installed: item.installed, handshakeOk: item.handshakeOk, error: item.error } : item
        })
      })
      if (result.enabledIds) setEnabledIds(result.enabledIds)
    } catch {
      // silently fail
    } finally {
      setDiscovering(false)
    }
  }

  useEffect(() => { loadDiscovery() }, [])

  const handleToggle = (id: string, checked: boolean) => {
    const next = checked
      ? [...enabledIds, id]
      : enabledIds.filter(x => x !== id)
    setEnabledIds(next)
    saveImmediate(next)
  }

  const statusLabel = (s: AcpDiscoveryItem['status']) => {
    switch (s) {
      case 'available': return t('settingsAcpAvailable')
      case 'installed': return t('settingsAcpInstalled')
      case 'missing': return t('settingsAcpMissing')
      case 'failed': return t('settingsAcpFailed')
    }
  }

  return (
    <SettingsCard
      title={t('settingsAcpTitle')}
      icon={Server}
      trailing={
        <div className="flex items-center gap-2">
          <SaveIndicator saving={saving} saved={saved} error={error} />
          <Button
            size="sm"
            variant="secondary"
            isPending={discovering}
            onPress={loadDiscovery}
          >
            {({ isPending }) => (
              <>
                {isPending ? null : <RefreshCw size={12} />}
                {t('settingsAcpRefresh')}
              </>
            )}
          </Button>
        </div>
      }
    >
      <div className="space-y-2">
        {discovery.length === 0 && !discovering && (
          <p className="text-xs text-muted-foreground">{t('settingsAcpEmpty')}</p>
        )}
        {discovering && discovery.length === 0 && (
          <p className="text-xs text-muted-foreground">{t('settingsAcpRefreshing')}...</p>
        )}
        {discovery.map(item => {
          const checked = enabledIds.includes(item.id)
          const disabled = item.status === 'missing'
          return (
            <div
              key={item.id}
              className={`flex items-start gap-3 rounded-lg border p-3 transition ${disabled ? 'opacity-50' : ''} ${checked && !disabled ? 'border-primary bg-primary/5' : 'border-border/50 hover:bg-secondary/30'}`}
            >
              <Checkbox
                size="sm"
                isSelected={checked}
                isDisabled={disabled}
                onChange={(isChecked) => handleToggle(item.id, isChecked)}
                aria-label={item.label}
              >
                <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
              </Checkbox>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-foreground">{item.label}</span>
                  <Chip size="sm" color={statusColor(item.status)} variant="soft" className="h-4 text-[9px]">
                    <Chip.Label>{statusLabel(item.status)}</Chip.Label>
                  </Chip>
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">{item.command} · {item.compatibility}</div>
                {item.error && <div className="mt-0.5 text-[11px] text-destructive">{item.error}</div>}
              </div>
            </div>
          )
        })}
      </div>
    </SettingsCard>
  )
}