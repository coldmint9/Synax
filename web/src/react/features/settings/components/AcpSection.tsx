import { useState, useCallback } from 'react'
import { Server, RefreshCw } from 'lucide-react'
import { SettingsSection } from './SettingsSection'
import { SaveIndicator } from './SaveIndicator'
import { useAutoSave } from '../useAutoSave'
import { configApi } from '../../../../lib/api/config'
import type { AcpDiscoveryItem, GlobalConfig } from '../../../../lib/contracts/config'

interface AcpSectionProps {
  config: GlobalConfig
  onUpdate: (patch: Record<string, unknown>) => Promise<void>
  onReload: () => Promise<void>
}

const statusClass = (s: AcpDiscoveryItem['status']) => {
  switch (s) {
    case 'available': return 'text-[10px] rounded-full bg-success/10 text-success px-1.5 py-0.5'
    case 'installed': return 'text-[10px] rounded-full bg-primary/10 text-primary px-1.5 py-0.5'
    case 'missing': return 'text-[10px] rounded-full bg-muted text-muted-foreground px-1.5 py-0.5'
    case 'failed': return 'text-[10px] rounded-full bg-destructive/10 text-destructive px-1.5 py-0.5'
  }
}

const statusLabel = (s: AcpDiscoveryItem['status']) => {
  switch (s) {
    case 'available': return '可用'
    case 'installed': return '已安装'
    case 'missing': return '未安装'
    case 'failed': return '失败'
  }
}

export function AcpSection({ config, onUpdate, onReload }: AcpSectionProps) {
  const [selectedId, setSelectedId] = useState(config.defaultProviderId)
  const [discovery, setDiscovery] = useState<AcpDiscoveryItem[]>([])
  const [discovering, setDiscovering] = useState(false)

  const saveFn = useCallback(async (providerId: string) => {
    await onUpdate({ defaultProviderId: providerId })
  }, [onUpdate])

  const { saveImmediate, saving, saved, error } = useAutoSave(saveFn)

  const loadDiscovery = async () => {
    setDiscovering(true)
    try {
      const result = await configApi.discoverAcp()
      setDiscovery(result.supported)
      if (result.selectedProviderId) setSelectedId(result.selectedProviderId)
    } catch {
      // silently fail
    } finally {
      setDiscovering(false)
    }
  }

  const handleSelect = (id: string) => {
    setSelectedId(id)
    saveImmediate(id)
  }

  return (
    <SettingsSection
      title="画布 ACP"
      icon={Server}
      trailing={
        <div className="flex items-center gap-2">
          <SaveIndicator saving={saving} saved={saved} error={error} />
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-50"
            onClick={loadDiscovery}
            disabled={discovering}
          >
            <RefreshCw size={11} className={discovering ? 'animate-spin' : ''} />
            {discovering ? '检测中' : '刷新检测'}
          </button>
        </div>
      }
    >
      <div className="space-y-2">
        {discovery.length === 0 && (
          <p className="text-xs text-muted-foreground">点击刷新检测以发现可用的 ACP 工具。</p>
        )}
        {discovery.map(item => (
          <label
            key={item.id}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${selectedId === item.id ? 'border-primary bg-primary/5' : 'border-border/50 hover:bg-secondary/30'}`}
          >
            <input
              type="radio"
              className="mt-0.5"
              name="acp-provider"
              checked={selectedId === item.id}
              onChange={() => handleSelect(item.id)}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-foreground">{item.label}</span>
                <span className={statusClass(item.status)}>{statusLabel(item.status)}</span>
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">{item.command} · {item.compatibility}</div>
              {item.error && <div className="mt-0.5 text-[11px] text-destructive">{item.error}</div>}
            </div>
          </label>
        ))}
      </div>
    </SettingsSection>
  )
}
