import { useEffect, useState } from 'react'
import { AlertTriangle, MonitorCog, ShieldCheck } from 'lucide-react'
import { SettingsCard } from './SettingsCard'
import { ComputerUsePermissionTip } from './ComputerUsePermissionTip'
import type { ComputerUseSettings as Config } from '../../../../lib/contracts/project-settings'

type Status = { state: string; error: string | null }
const DEFAULT: Config = { enabled: true, strategy: 'auto', perception: 'disabled' }

type DriverTone = 'ready' | 'pending' | 'danger' | 'muted'

function driverStatus(state: string | undefined, zh: boolean): { label: string; tone: DriverTone } {
  switch (state) {
    case 'ready': return { label: zh ? '已就绪' : 'Ready', tone: 'ready' }
    case 'starting': return { label: zh ? '启动中' : 'Starting', tone: 'pending' }
    case 'restarting': return { label: zh ? '重启中' : 'Restarting', tone: 'pending' }
    case 'stopped': return { label: zh ? '已停止' : 'Stopped', tone: 'muted' }
    case 'unavailable': return { label: zh ? '不可用' : 'Unavailable', tone: 'danger' }
    default: return { label: zh ? '非桌面应用' : 'Not in desktop app', tone: 'muted' }
  }
}

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
  const statusView = driverStatus(status?.state, zh)
  const permissionIssue = status?.error?.includes('Accessibility and Screen Recording')

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
    setSaving(true)
    setError(null)
    try { await onSave(next) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setSaving(false) }
  }

  return (
    <SettingsCard title={zh ? '电脑操作' : 'Computer Use'} description={zh ? 'Cua Driver 由桌面应用异步托管；Jev 可选。' : 'Cua Driver runs asynchronously under the desktop app; Jev is optional.'}>
      <div className="computer-use-settings">
        <div className="computer-use-overview" role="status" aria-live="polite">
          <div className="computer-use-overview__icon" aria-hidden="true"><MonitorCog size={20} strokeWidth={1.8} /></div>
          <div className="computer-use-overview__copy">
            <div className="computer-use-overview__topline">
              <span className="computer-use-overview__eyebrow">{zh ? '项目覆盖' : 'Project override'}</span>
              <span className={`computer-use-status computer-use-status--${statusView.tone}`}><span className="computer-use-status__dot" aria-hidden="true" />{statusView.label}</span>
            </div>
            <p>{status?.error ?? (zh ? '本项目的配置会覆盖全局默认值。' : 'This project overrides the global defaults.')}</p>
          </div>
        </div>

        {permissionIssue ? (
          <div className="computer-use-alert" role="alert">
            <div className="computer-use-alert__icon" aria-hidden="true"><AlertTriangle size={17} /></div>
            <div className="computer-use-alert__copy">
              <strong>{zh ? '需要桌面权限' : 'Desktop permissions required'}</strong>
              <p>{zh ? '开启辅助功能和屏幕录制权限后，电脑操作才能控制当前桌面。' : 'Computer Use needs Accessibility and Screen Recording access to control the desktop.'}</p>
              <ComputerUsePermissionTip
                zh={zh}
                onOpenPermission={target => void (window as any).electronAPI?.openComputerUsePermissions?.(target)}
              />
            </div>
          </div>
        ) : null}

        <section className="computer-use-panel" aria-labelledby="computer-use-project-heading">
          <div className="computer-use-panel__header">
            <div>
              <h3 id="computer-use-project-heading">{zh ? '项目设置' : 'Project settings'}</h3>
              <p>{zh ? '仅影响当前项目，不会改变其他项目的默认值。' : 'Only affects this project and does not change the global defaults.'}</p>
            </div>
            <ShieldCheck size={18} aria-hidden="true" />
          </div>
          <div className="computer-use-rows">
            <label className="computer-use-row computer-use-row--toggle">
              <span className="computer-use-field-copy"><span className="computer-use-field-title">{zh ? '启用电脑操作' : 'Enable Computer Use'}</span><span className="computer-use-field-description">{zh ? '允许代理在此项目中观察并操作桌面。' : 'Allow agents to observe and operate the desktop in this project.'}</span></span>
              <span className="computer-use-control"><input className="computer-use-switch" type="checkbox" checked={current.enabled} disabled={saving} onChange={e => void save({ ...current, enabled: e.target.checked })} /></span>
            </label>
            <label className="computer-use-row">
              <span className="computer-use-field-copy"><span className="computer-use-field-title">{zh ? '策略' : 'Strategy'}</span><span className="computer-use-field-description">{zh ? '自动模式默认直接使用 Cua。' : 'Auto mode uses Direct Cua by default.'}</span></span>
              <span className="computer-use-control"><select className="computer-use-select" aria-label={zh ? '电脑操作策略' : 'Computer Use strategy'} value={current.strategy} disabled={saving || !current.enabled} onChange={e => void save({ ...current, strategy: e.target.value as Config['strategy'] })}><option value="auto">{zh ? '自动' : 'Auto'}</option><option value="direct">Direct Cua</option><option value="jev" disabled={!current.jev?.enabled}>{zh ? 'Jev 辅助' : 'Jev assisted'}</option></select></span>
            </label>
          </div>
        </section>

        <section className="computer-use-panel computer-use-panel--advanced" aria-labelledby="computer-use-project-jev-heading">
          <div className="computer-use-panel__header">
            <div>
              <div className="computer-use-panel__title-row"><h3 id="computer-use-project-jev-heading">{zh ? 'Jev 辅助' : 'Jev assistance'}</h3><span className="computer-use-chip">{zh ? '可选' : 'Optional'}</span></div>
              <p>{zh ? '项目级开关会覆盖全局 Jev 配置。' : 'The project-level switch overrides the global Jev configuration.'}</p>
            </div>
            <input className="computer-use-switch" type="checkbox" checked={current.jev?.enabled ?? false} disabled={saving} aria-label={zh ? '启用 Jev 辅助' : 'Enable Jev assistance'} onChange={e => void save({ ...current, jev: { ...current.jev, enabled: e.target.checked, fallback: current.jev?.fallback ?? 'fail_closed' }, strategy: !e.target.checked && current.strategy === 'jev' ? 'auto' : current.strategy })} />
          </div>
          {current.jev?.enabled ? (
            <div className="computer-use-rows">
              <label className="computer-use-row">
                <span className="computer-use-field-copy"><span className="computer-use-field-title">{zh ? '失败时的处理' : 'Failure behavior'}</span><span className="computer-use-field-description">{zh ? '安全默认会停止操作。' : 'The safe default stops desktop actions.'}</span></span>
                <span className="computer-use-control"><select className="computer-use-select" aria-label={zh ? 'Jev 失败策略' : 'Jev failure policy'} value={current.jev.fallback} disabled={saving} onChange={e => void save({ ...current, jev: { ...current.jev!, fallback: e.target.value as 'direct' | 'fail_closed' } })}><option value="fail_closed">{zh ? '停止操作' : 'Stop actions'}</option><option value="direct">{zh ? '允许直接使用 Cua' : 'Allow Direct Cua'}</option></select></span>
              </label>
            </div>
          ) : <p className="computer-use-panel__empty">{zh ? '开启后可在项目级别配置失败策略。' : 'Enable Jev to configure failure behavior for this project.'}</p>}
        </section>

        {error ? <div className="computer-use-form-error" role="alert"><AlertTriangle size={15} aria-hidden="true" />{error}</div> : null}
      </div>
    </SettingsCard>
  )
}
