import { useEffect, useState } from 'react'
import { SettingsCard } from './SettingsCard'
import type { ComputerUseSettings as Config } from '../../../../lib/contracts/project-settings'

type Status = { state: string; error: string | null }
const DEFAULT: Config = { enabled: true, strategy: 'auto', perception: 'disabled' }

export function ComputerUseSettings({ value, onSave, locale }: {
  value?: Config
  onSave: (value: Config) => Promise<unknown>
  locale: string
}) {
  const zh = locale.startsWith('zh')
  const current = value ?? DEFAULT
  const [status, setStatus] = useState<Status | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let mounted = true
    const api = (window as Window & { electronAPI?: { getComputerUseStatus?: () => Promise<Status> } }).electronAPI
    if (!api?.getComputerUseStatus) return
    const refresh = () => { void api.getComputerUseStatus?.().then(state => { if (mounted) setStatus(state) }).catch(() => {}) }
    refresh()
    const timer = window.setInterval(refresh, 5_000)
    return () => { mounted = false; window.clearInterval(timer) }
  }, [])
  async function save(next: Config) {
    setSaving(true); setError(null)
    try { await onSave(next) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setSaving(false) }
  }
  return <SettingsCard title={zh ? '电脑操作' : 'Computer Use'} description={zh ? 'Cua Driver 由桌面应用异步托管；Jev 可选。' : 'Cua Driver runs asynchronously under the desktop app; Jev is optional.'}>
    <div className="space-y-3 text-sm">
      <p role="status">{zh ? '驱动状态' : 'Driver status'}: {status?.state ?? (zh ? '非桌面应用' : 'Not in desktop app')}{status?.error ? ` — ${status.error}` : ''}</p>
      {status?.error?.includes('Accessibility and Screen Recording') ? <div className="flex gap-3">
        <button type="button" className="text-primary underline" onClick={() => void (window as any).electronAPI?.openComputerUsePermissions?.('accessibility')}>{zh ? '打开辅助功能设置' : 'Open Accessibility settings'}</button>
        <button type="button" className="text-primary underline" onClick={() => void (window as any).electronAPI?.openComputerUsePermissions?.('screen-recording')}>{zh ? '打开屏幕录制设置' : 'Open Screen Recording settings'}</button>
      </div> : null}
      <label className="flex items-center gap-2"><input type="checkbox" checked={current.enabled} disabled={saving} onChange={e => void save({ ...current, enabled: e.target.checked })} />{zh ? '启用电脑操作' : 'Enable Computer Use'}</label>
      <label className="flex items-center gap-2">{zh ? '策略' : 'Strategy'}
        <select aria-label={zh ? '电脑操作策略' : 'Computer Use strategy'} value={current.strategy} disabled={saving || !current.enabled} onChange={e => void save({ ...current, strategy: e.target.value as Config['strategy'] })}>
          <option value="auto">{zh ? '自动（默认直接使用 Cua）' : 'Auto (Direct Cua by default)'}</option>
          <option value="direct">Direct Cua</option>
          <option value="jev" disabled={!current.jev?.enabled}>{zh ? 'Jev 辅助' : 'Jev assisted'}</option>
        </select>
      </label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={current.jev?.enabled ?? false} disabled={saving} onChange={e => void save({ ...current, jev: { ...current.jev, enabled: e.target.checked, fallback: current.jev?.fallback ?? 'fail_closed' }, strategy: !e.target.checked && current.strategy === 'jev' ? 'auto' : current.strategy })} />{zh ? '启用 Jev（密钥在 全局设置 → 电脑操作 配置，或设置 TYPESAFE_API_KEY）' : 'Enable Jev (configure the key in Settings → Computer Use, or set TYPESAFE_API_KEY)'}</label>
      {current.jev?.enabled ? <label className="flex items-center gap-2">{zh ? 'Jev 失败时' : 'If Jev fails'}
        <select aria-label={zh ? 'Jev 失败策略' : 'Jev failure policy'} value={current.jev.fallback} disabled={saving} onChange={e => void save({ ...current, jev: { ...current.jev!, fallback: e.target.value as 'direct' | 'fail_closed' } })}>
          <option value="fail_closed">{zh ? '停止操作（安全默认）' : 'Stop (safe default)'}</option>
          <option value="direct">{zh ? '允许直接使用 Cua 工具' : 'Allow Direct Cua tools'}</option>
        </select>
      </label> : null}
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    </div>
  </SettingsCard>
}
