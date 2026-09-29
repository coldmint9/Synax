import { useState } from 'react'
import { AlertTriangle, KeyRound, MonitorCog, ShieldCheck } from 'lucide-react'
import { SettingsCard } from './SettingsCard'
import type {
  GlobalComputerUseSettings as Config,
  UpdateGlobalConfigRequest,
} from '../../../../lib/contracts/config'
import {
  openComputerUsePermission,
  useComputerUseStatus,
} from '../useComputerUseStatus'

const DEFAULT: Config = { enabled: true, strategy: 'auto', perception: 'disabled' }

type Jev = NonNullable<Config['jev']>

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

export function ComputerUseGlobalSettings({ value, locale, onUpdate }: {
  value?: Config
  locale: string
  onUpdate: (patch: UpdateGlobalConfigRequest) => Promise<unknown>
}) {
  const zh = locale.startsWith('zh')
  const current = value ?? DEFAULT
  const jev: Jev = current.jev ?? {}
  const status = useComputerUseStatus()
  const statusView = driverStatus(status?.state, zh)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState('')

  async function save(next: Config) {
    setSaving(true)
    setError(null)
    try {
      await onUpdate({ computerUse: next })
      setKeyDraft('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const withJev = (patch: Partial<Jev>): Config => ({ ...current, jev: { ...jev, ...patch } })
  const saved = jev.apiKeyMasked
  const permissionIssue = status?.error?.includes('Accessibility and Screen Recording')

  return (
    <SettingsCard
      title={zh ? '电脑操作' : 'Computer Use'}
      description={zh
        ? '这里的默认值对所有项目生效；单个项目可在项目设置中覆盖。'
        : 'These defaults apply to every project; a project can override them in its own settings.'}
    >
      <div className="computer-use-settings">
        <div className="computer-use-overview" role="status" aria-live="polite">
          <div className="computer-use-overview__icon" aria-hidden="true">
            <MonitorCog size={20} strokeWidth={1.8} />
          </div>
          <div className="computer-use-overview__copy">
            <div className="computer-use-overview__topline">
              <span className="computer-use-overview__eyebrow">{zh ? '运行时状态' : 'Runtime status'}</span>
              <span className={`computer-use-status computer-use-status--${statusView.tone}`}>
                <span className="computer-use-status__dot" aria-hidden="true" />
                {statusView.label}
              </span>
            </div>
            <p>{status?.error ?? (zh ? 'Cua Driver 由桌面应用异步托管。' : 'Cua Driver is managed asynchronously by the desktop app.')}</p>
          </div>
        </div>

        {permissionIssue ? (
          <div className="computer-use-alert" role="alert">
            <div className="computer-use-alert__icon" aria-hidden="true"><AlertTriangle size={17} /></div>
            <div className="computer-use-alert__copy">
              <strong>{zh ? '需要桌面权限' : 'Desktop permissions required'}</strong>
              <p>{zh ? '开启辅助功能和屏幕录制权限后，电脑操作才能控制当前桌面。' : 'Computer Use needs Accessibility and Screen Recording access to control the desktop.'}</p>
              <div className="computer-use-alert__actions">
                <button type="button" className="computer-use-button computer-use-button--secondary" onClick={() => openComputerUsePermission('accessibility')}>
                  {zh ? '辅助功能' : 'Accessibility'}
                </button>
                <button type="button" className="computer-use-button computer-use-button--secondary" onClick={() => openComputerUsePermission('screen-recording')}>
                  {zh ? '屏幕录制' : 'Screen Recording'}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <section className="computer-use-panel" aria-labelledby="computer-use-runtime-heading">
          <div className="computer-use-panel__header">
            <div>
              <h3 id="computer-use-runtime-heading">{zh ? '运行模式' : 'Runtime behavior'}</h3>
              <p>{zh ? '控制默认的电脑操作方式和视觉能力。' : 'Choose how desktop actions and visual perception are handled by default.'}</p>
            </div>
            <ShieldCheck size={18} aria-hidden="true" />
          </div>
          <div className="computer-use-rows">
            <label className="computer-use-row computer-use-row--toggle">
              <span className="computer-use-field-copy">
                <span className="computer-use-field-title">{zh ? '启用电脑操作' : 'Enable Computer Use'}</span>
                <span className="computer-use-field-description">{zh ? '允许代理观察并操作当前桌面。' : 'Allow agents to observe and operate the current desktop.'}</span>
              </span>
              <span className="computer-use-control">
                <input className="computer-use-switch" type="checkbox" checked={current.enabled !== false} disabled={saving} onChange={e => void save({ ...current, enabled: e.target.checked })} />
              </span>
            </label>
            <label className="computer-use-row">
              <span className="computer-use-field-copy">
                <span className="computer-use-field-title">{zh ? '策略' : 'Strategy'}</span>
                <span className="computer-use-field-description">{zh ? '自动模式默认直接使用 Cua。' : 'Auto mode uses Direct Cua by default.'}</span>
              </span>
              <span className="computer-use-control">
                <select className="computer-use-select" aria-label={zh ? '电脑操作策略' : 'Computer Use strategy'} value={current.strategy ?? 'auto'} disabled={saving || current.enabled === false} onChange={e => void save({ ...current, strategy: e.target.value as Config['strategy'] })}>
                  <option value="auto">{zh ? '自动' : 'Auto'}</option>
                  <option value="direct">Direct Cua</option>
                  <option value="jev" disabled={jev.enabled !== true}>{zh ? 'Jev 辅助' : 'Jev assisted'}</option>
                </select>
              </span>
            </label>
            <label className="computer-use-row">
              <span className="computer-use-field-copy">
                <span className="computer-use-field-title">{zh ? '视觉解析' : 'Visual perception'}</span>
                <span className="computer-use-field-description">{zh ? '需要时让模型辅助理解屏幕内容。' : 'Let a model help interpret the screen when needed.'}</span>
              </span>
              <span className="computer-use-control">
                <select className="computer-use-select" aria-label={zh ? '视觉解析' : 'Visual perception'} value={current.perception ?? 'disabled'} disabled={saving || current.enabled === false} onChange={e => void save({ ...current, perception: e.target.value as Config['perception'] })}>
                  <option value="disabled">{zh ? '关闭' : 'Disabled'}</option>
                  <option value="auto">{zh ? '可用时自动' : 'Auto when available'}</option>
                  <option value="required">{zh ? '必须可用' : 'Required'}</option>
                </select>
              </span>
            </label>
          </div>
        </section>

        <section className="computer-use-panel computer-use-panel--advanced" aria-labelledby="computer-use-jev-heading">
          <div className="computer-use-panel__header">
            <div>
              <div className="computer-use-panel__title-row">
                <h3 id="computer-use-jev-heading">{zh ? 'Jev 辅助' : 'Jev assistance'}</h3>
                <span className="computer-use-chip">{zh ? '可选' : 'Optional'}</span>
              </div>
              <p>{zh ? '在需要时使用外部视觉模型辅助决策。' : 'Use an external visual model to assist decisions when needed.'}</p>
            </div>
            <input className="computer-use-switch" type="checkbox" checked={jev.enabled === true} disabled={saving} aria-label={zh ? '启用 Jev 辅助' : 'Enable Jev assistance'} onChange={e => void save({ ...current, jev: { ...jev, enabled: e.target.checked, fallback: jev.fallback ?? 'fail_closed' }, strategy: !e.target.checked && current.strategy === 'jev' ? 'auto' : current.strategy })} />
          </div>
          {jev.enabled === true ? (
            <div className="computer-use-rows">
              <label className="computer-use-row">
                <span className="computer-use-field-copy">
                  <span className="computer-use-field-title">{zh ? '失败时的处理' : 'Failure behavior'}</span>
                  <span className="computer-use-field-description">{zh ? '安全默认会停止操作。' : 'The safe default stops desktop actions.'}</span>
                </span>
                <span className="computer-use-control">
                  <select className="computer-use-select" aria-label={zh ? 'Jev 失败策略' : 'Jev failure policy'} value={jev.fallback ?? 'fail_closed'} disabled={saving} onChange={e => void save(withJev({ fallback: e.target.value as Jev['fallback'] }))}>
                    <option value="fail_closed">{zh ? '停止操作' : 'Stop actions'}</option>
                    <option value="direct">{zh ? '允许直接使用 Cua' : 'Allow Direct Cua'}</option>
                  </select>
                </span>
              </label>
              <label className="computer-use-row">
                <span className="computer-use-field-copy">
                  <span className="computer-use-field-title">{zh ? '供应商标识' : 'Provider ID'}</span>
                  <span className="computer-use-field-description">{zh ? '可选，用于指定 Jev 供应商。' : 'Optional identifier for the Jev provider.'}</span>
                </span>
                <span className="computer-use-control">
                  <input className="computer-use-input" type="text" aria-label={zh ? 'Jev 供应商标识' : 'Jev provider id'} defaultValue={jev.providerId ?? ''} disabled={saving} onBlur={e => { const next = e.target.value.trim(); if (next !== (jev.providerId ?? '')) void save(withJev({ providerId: next || null })) }} />
                </span>
              </label>
              <label className="computer-use-row">
                <span className="computer-use-field-copy">
                  <span className="computer-use-field-title">{zh ? '模型' : 'Model'}</span>
                  <span className="computer-use-field-description">{zh ? '可选，用于指定 Jev 模型。' : 'Optional model override for Jev.'}</span>
                </span>
                <span className="computer-use-control">
                  <input className="computer-use-input" type="text" aria-label={zh ? 'Jev 模型' : 'Jev model'} defaultValue={jev.model ?? ''} disabled={saving} onBlur={e => { const next = e.target.value.trim(); if (next !== (jev.model ?? '')) void save(withJev({ model: next || null })) }} />
                </span>
              </label>
              <div className="computer-use-row computer-use-row--key">
                <div className="computer-use-field-copy">
                  <span className="computer-use-field-title"><KeyRound size={14} aria-hidden="true" />{zh ? 'API 密钥' : 'API key'}</span>
                  <span className="computer-use-field-description">{saved ? (zh ? `已保存：${saved}` : `Stored: ${saved}`) : (zh ? '未保存，将回退到 TYPESAFE_API_KEY。' : 'Not stored; falls back to TYPESAFE_API_KEY.')}</span>
                </div>
                <div className="computer-use-key-control">
                  <input className="computer-use-input" type="password" aria-label={zh ? 'Jev API 密钥' : 'Jev API key'} placeholder={saved ? (zh ? '输入新密钥以替换' : 'Enter a replacement') : (zh ? '粘贴 API 密钥' : 'Paste API key')} value={keyDraft} disabled={saving} onChange={e => setKeyDraft(e.target.value)} />
                  <div className="computer-use-button-group">
                    <button type="button" className="computer-use-button computer-use-button--primary" disabled={saving || !keyDraft} onClick={() => void save(withJev({ apiKey: keyDraft }))}>{zh ? '保存' : 'Save'}</button>
                    <button type="button" className="computer-use-button computer-use-button--ghost" disabled={saving || !saved} onClick={() => void save(withJev({ apiKey: '' }))}>{zh ? '清除' : 'Clear'}</button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <p className="computer-use-panel__empty">{zh ? '开启后可配置失败策略、模型和 API 密钥。' : 'Enable Jev to configure failure behavior, model, and API key.'}</p>
          )}
        </section>

        {error ? <div className="computer-use-form-error" role="alert"><AlertTriangle size={15} aria-hidden="true" />{error}</div> : null}
      </div>
    </SettingsCard>
  )
}
