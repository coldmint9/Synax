import { useState, useCallback, useEffect, useRef } from 'react'
import { Button, Checkbox } from '@heroui/react'
import { Server, RefreshCw } from 'lucide-react'
import { SettingsCard } from './SettingsCard'
import { SaveIndicator } from './SaveIndicator'
import { useAutoSave } from '../useAutoSave'
import { configApi } from '../../../../lib/api/config'
import type { AcpDiscoveryItem, GlobalConfig } from '../../../../lib/contracts/config'
import { detectedAcpItems } from '../lib/acpItems'
import { useLocale } from '../../../../hooks/useLocale'

interface AcpSectionProps {
  config: GlobalConfig
  onUpdate: (patch: Record<string, unknown>) => Promise<void>
  onReload: () => Promise<void>
}

const ACP_DISCOVERY_CACHE_KEY = 'synax-acp-discovery-cache'
const ACP_DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000

let memoryDiscoveryCache: { supported: AcpDiscoveryItem[]; fetchedAt: number } | null = null

function readDiscoveryCache(): AcpDiscoveryItem[] | null {
  const now = Date.now()
  if (memoryDiscoveryCache && now - memoryDiscoveryCache.fetchedAt < ACP_DISCOVERY_CACHE_TTL_MS) {
    return memoryDiscoveryCache.supported
  }
  if (typeof sessionStorage === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(ACP_DISCOVERY_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { supported?: AcpDiscoveryItem[]; fetchedAt?: number }
    if (!Array.isArray(parsed.supported) || typeof parsed.fetchedAt !== 'number') return null
    if (now - parsed.fetchedAt >= ACP_DISCOVERY_CACHE_TTL_MS) return null
    memoryDiscoveryCache = { supported: parsed.supported, fetchedAt: parsed.fetchedAt }
    return parsed.supported
  } catch {
    return null
  }
}

function writeDiscoveryCache(supported: AcpDiscoveryItem[]): void {
  const entry = { supported, fetchedAt: Date.now() }
  memoryDiscoveryCache = entry
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(ACP_DISCOVERY_CACHE_KEY, JSON.stringify(entry))
  } catch {
    // Cache is an optimization; ignore storage quota/privacy failures.
  }
}

const statusChipClass = (s: AcpDiscoveryItem['status']): string => {
  switch (s) {
    case 'available': return 'settings-chip settings-chip--success'
    case 'installed': return 'settings-chip'
    case 'missing': return 'settings-chip settings-chip--muted'
    case 'failed': return 'settings-chip settings-chip--muted'
  }
}

export function AcpSection({ config, onUpdate }: AcpSectionProps) {
  const { t } = useLocale()
  const [enabledIds, setEnabledIds] = useState<string[]>(config.enabledAcpProviderIds ?? [config.defaultProviderId])
  const [discovery, setDiscovery] = useState<AcpDiscoveryItem[]>([])
  const [discovering, setDiscovering] = useState(false)
  const didAutoEnableRef = useRef(false)
  const visibleDiscovery = detectedAcpItems(discovery)

  const saveFn = useCallback(async (ids: string[]) => {
    await configApi.updateGlobal({ enabledAcpProviderIds: ids, defaultProviderId: ids[0] || config.defaultProviderId })
  }, [config.defaultProviderId])

  const { saveImmediate, saving, saved, error } = useAutoSave(saveFn)

  const loadDiscovery = async (force = false) => {
    if (!force) {
      const cached = readDiscoveryCache()
      if (cached) {
        setDiscovery(cached)
        // Enabled state is configuration, not discovery output; keep it from the current config.
        setEnabledIds(config.enabledAcpProviderIds ?? [config.defaultProviderId])
        return
      }
    }

    setDiscovering(true)
    try {
      const result = await configApi.discoverAcp()
      writeDiscoveryCache(result.supported)
      setDiscovery(prev => {
        if (prev.length === 0) return result.supported
        return result.supported.map(item => {
          const existing = prev.find(p => p.id === item.id)
          return existing ? { ...existing, status: item.status, installed: item.installed, handshakeOk: item.handshakeOk, error: item.error } : item
        })
      })
      if (result.enabledIds) setEnabledIds(result.enabledIds)

      const availableIds = result.supported
        .filter(item => item.status === 'available' && item.handshakeOk)
        .map(item => item.id)
      const currentEnabled = result.enabledIds ?? enabledIds
      const missingEnabled = availableIds.filter(id => !currentEnabled.includes(id))
      if (!didAutoEnableRef.current && missingEnabled.length > 0) {
        didAutoEnableRef.current = true
        const nextIds = [...currentEnabled, ...missingEnabled]
        setEnabledIds(nextIds)
        saveImmediate(nextIds)
      }
    } catch {
      // silently fail
    } finally {
      setDiscovering(false)
    }
  }

  useEffect(() => { void loadDiscovery() }, [])

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
            className="wh-pill-btn wh-pill-btn--soft wh-pill-btn--sm"
            isPending={discovering}
            onPress={() => void loadDiscovery(true)}
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
        {visibleDiscovery.length === 0 && !discovering && (
          <p className="text-xs text-muted-foreground">{t('settingsAcpEmpty')}</p>
        )}
        {discovering && visibleDiscovery.length === 0 && (
          <p className="text-xs text-muted-foreground">{t('settingsAcpRefreshing')}...</p>
        )}
        {visibleDiscovery.map(item => {
          const checked = enabledIds.includes(item.id)
          return (
            <div
              key={item.id}
              className={`settings-item flex items-start gap-3 p-3 ${checked ? 'settings-item--active' : ''}`}
            >
              <Checkbox
                isSelected={checked}
                onChange={(isChecked) => handleToggle(item.id, isChecked)}
                aria-label={item.label}
              >
                <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
              </Checkbox>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-foreground">{item.label}</span>
                  <span className={statusChipClass(item.status)}>{statusLabel(item.status)}</span>
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