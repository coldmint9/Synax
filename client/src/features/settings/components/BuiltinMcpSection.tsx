import { useRef, useState } from 'react'
import { Switch } from '@/shared/ui/ui/Toggle'
import { useLocale } from '../../../shared/hooks/useLocale'
import type { GlobalConfig } from '../../../shared/contracts/config'
import { useComputerUseStatus } from '../useComputerUseStatus'

type Config = NonNullable<GlobalConfig['computerUse']>

export function BuiltinMcpSection({ value, onSave }: {
  value?: Config
  onSave: (value: Config) => Promise<void>
}) {
  const { locale } = useLocale()
  const zh = locale === 'zh'
  const status = useComputerUseStatus()
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const labels: Record<string, string> = {
    ready: zh ? '已就绪' : 'Ready',
    starting: zh ? '启动中' : 'Starting',
    restarting: zh ? '重启中' : 'Restarting',
    stopped: zh ? '已停止' : 'Stopped',
    unavailable: zh ? '不可用' : 'Unavailable',
  }
  async function toggle(enabled: boolean) {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      await onSave({ strategy: 'auto', perception: 'disabled', ...value, enabled })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  return (
    <div className="mb-4 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          Cua Driver
          <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{zh ? '内置' : 'Built-in'}</span>
        </div>
        <Switch aria-label={zh ? '启用 Cua Driver' : 'Enable Cua Driver'} checked={value?.enabled !== false} disabled={saving} onChange={enabled => void toggle(enabled)} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {zh ? '桌面观察与操作。此开关与“电脑操作”共用全局设置，项目仍可单独禁用。' : 'Desktop observation and actions. Shares the global Computer Use setting; projects can disable it separately.'}
      </p>
      <p className="mt-2 text-xs text-muted-foreground" role="status">
        {zh ? '驱动状态：' : 'Driver status: '}
        {status ? (labels[status.state] ?? (zh ? '未知' : 'Unknown')) : (zh ? '未获取（需要桌面应用）' : 'Not available (desktop app required)')}
        {saving && (zh ? ' · 保存中…' : ' · Saving…')}
      </p>
      {status?.error && <p className="mt-1 text-xs text-destructive">{status.error}</p>}
      {error && <p className="mt-1 text-xs text-destructive" role="alert">{error}</p>}
    </div>
  )
}
