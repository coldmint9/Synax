import { useState } from 'react'
import { AlertTriangle, KeyRound, ShieldCheck } from 'lucide-react'
import { SettingsCard } from './SettingsCard'
import './computer-use-settings.css'
import type {
  GlobalComputerUseSettings as Config,
  ProviderDef,
  UpdateGlobalConfigRequest,
} from '../../../shared/contracts/config'
import {
  openComputerUsePermission,
  useComputerUsePermissions,
  useComputerUseStatus,
} from '../useComputerUseStatus'

const DEFAULT: Config = { enabled: false, strategy: 'auto', perception: 'disabled' }

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

export function ComputerUseGlobalSettings({ value, locale, providers, onConfigureProvider, onUpdate }: {
  value?: Config
  locale: string
  /** Configured providers; Jev may be routed through any of them. */
  providers?: ProviderDef[]
  onConfigureProvider?: () => void
  onUpdate: (patch: UpdateGlobalConfigRequest) => Promise<unknown>
}) {
  const zh = locale.startsWith('zh')
  const current = value ?? DEFAULT
  const jev: Jev = current.jev ?? {}
  const status = useComputerUseStatus()
  const { permissions, refresh: refreshPermissions } = useComputerUsePermissions()
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
  const jevProviderOptions = (providers ?? [])
    .filter(provider => provider.kind === 'api' && provider.status !== 'inactive')
    .map(provider => ({ id: provider.id, label: provider.label || provider.id }))
  const hasOpenRouter = jevProviderOptions.some(option => option.id === 'custom-api:openrouter')
  if (jev.providerId && !jevProviderOptions.some(option => option.id === jev.providerId))
    jevProviderOptions.push({
      id: jev.providerId,
      label: `${jev.providerId} (${zh ? '当前不可用' : 'unavailable'})`,
    })
  const enabled = current.enabled === true
  const isMac = permissions?.platform === 'darwin'
  const modernScreenName = (permissions?.macOSMajorVersion ?? 0) >= 26
  const permissionRows = [
    { key: 'accessibility' as const, label: modernScreenName ? (zh ? '设备控制和数据访问' : 'Device Control & Data Access') : (zh ? '辅助功能' : 'Accessibility'), target: 'accessibility' as const },
    { key: 'screenRecording' as const, label: modernScreenName
      ? (zh ? '屏幕与系统音频录制' : 'Screen & System Audio Recording')
      : (zh ? '屏幕录制' : 'Screen Recording'), target: 'screen-recording' as const },
  ]

  return (
    <SettingsCard
      title={zh ? '电脑操作' : 'Computer Use'}
      description={zh
        ? '关闭总开关后，所有项目都不可使用电脑操作。'
        : 'The global switch controls access for every project. Projects can further restrict access.'}
    >
      <div className="computer-use-settings computer-use-settings--compact">
        <section className="computer-use-master">
          <label className="computer-use-row computer-use-row--toggle">
            <span className="computer-use-field-copy">
              <span className="computer-use-field-title">{zh ? '启用电脑操作' : 'Enable Computer Use'}</span>
              <span className="computer-use-field-description">{zh ? '允许代理观察屏幕并操作键盘和鼠标。默认关闭。' : 'Allow agents to view the screen and use the keyboard and mouse. Off by default.'}</span>
            </span>
            <span className="computer-use-control"><input className="computer-use-switch" type="checkbox" checked={enabled} disabled={saving} onChange={e => void save({ ...current, enabled: e.target.checked })} /></span>
          </label>
          <p className="computer-use-runtime-note" role="status" aria-live="polite">
            {!enabled ? (zh ? '已关闭 · 所有项目均不可使用' : 'Off · Unavailable to all projects')
              : isMac && (permissions.accessibility !== true || permissions.screenRecording !== true)
                ? (zh ? '等待系统授权 · 请通过下方链接设置权限' : 'Waiting for system access · Use the settings links below')
                : `${zh ? '运行状态' : 'Runtime'} · ${statusView.label}`}
          </p>
        </section>

        <section className="computer-use-panel" aria-labelledby="computer-use-permissions-heading">
          <div className="computer-use-panel__header">
            <div className="computer-use-panel__title-row">
              <ShieldCheck size={16} aria-hidden="true" />
              <h3 id="computer-use-permissions-heading">{zh ? '系统权限' : 'System permissions'}</h3>
            </div>
            <button type="button" className="computer-use-link" onClick={refreshPermissions}>{zh ? '重新检测' : 'Refresh detection'}</button>
          </div>
          <div className="computer-use-permissions" role="list">
            {permissionRows.map(row => {
              const value = permissions?.[row.key] ?? null
              const tone = !isMac || !permissions ? 'muted' : value === true ? 'ready' : value === false ? 'muted' : 'muted'
              const text = !isMac || !permissions ? (zh ? '无法检测' : 'Unavailable') : value === true ? (zh ? '已允许' : 'Allowed') : value === false ? (zh ? '未授权' : 'Not allowed') : (zh ? '无法检测' : 'Unavailable')
              return (
                <div key={row.key} className="computer-use-permission-row" role="listitem">
                  <div className="computer-use-overview__copy">
                    <div className="computer-use-overview__topline">
                      <span className="computer-use-overview__eyebrow">{row.label}</span>
                      <span className={`computer-use-status computer-use-status--${tone}`}><span className="computer-use-status__dot" aria-hidden="true" />{text}</span>
                    </div>
                  </div>
                  {isMac ? <button type="button" className="computer-use-link" aria-label={`${row.label} — ${zh ? '前往设置' : 'Open Settings'}`} onClick={() => { void openComputerUsePermission(row.target).catch(err => setError(String(err))) }}>{zh ? '前往设置 ↗' : 'Open Settings ↗'}</button> : null}
                </div>
              )
            })}
          </div>
          <p className="computer-use-runtime-note">{isMac
            ? (zh ? '仅检测权限，不自动请求授权。点击链接前往系统设置 → 隐私与安全性。' : 'Permissions are checked without prompting. Use the links to open System Settings → Privacy & Security.')
            : (zh ? '系统权限检测仅支持 macOS 桌面应用。' : 'System permission detection requires the macOS desktop app.')}</p>
          {permissions?.error ? <p className="computer-use-runtime-note" role="alert">{permissions.error}</p> : null}
        </section>

        <section className="computer-use-panel" aria-labelledby="computer-use-runtime-heading">
          <div className="computer-use-panel__header">
            <div>
              <h3 id="computer-use-runtime-heading">{zh ? '操作偏好' : 'Action preferences'}</h3>
              <p>{zh ? '控制默认的电脑操作方式和视觉能力。' : 'Choose how desktop actions and visual perception are handled by default.'}</p>
            </div>
            <ShieldCheck size={18} aria-hidden="true" />
          </div>
          <div className="computer-use-rows">
            <label className="computer-use-row">
              <span className="computer-use-field-copy">
                <span className="computer-use-field-title">{zh ? '策略' : 'Strategy'}</span>
                <span className="computer-use-field-description">{zh ? '自动模式默认直接使用 Cua。' : 'Auto mode uses Direct Cua by default.'}</span>
              </span>
              <span className="computer-use-control">
                <select className="computer-use-select" aria-label={zh ? '电脑操作策略' : 'Computer Use strategy'} value={current.strategy ?? 'auto'} disabled={saving || !enabled} onChange={e => void save({ ...current, strategy: e.target.value as Config['strategy'] })}>
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
                <select className="computer-use-select" aria-label={zh ? '视觉解析' : 'Visual perception'} value={current.perception ?? 'disabled'} disabled={saving || !enabled} onChange={e => void save({ ...current, perception: e.target.value as Config['perception'] })}>
                  <option value="disabled">{zh ? '关闭' : 'Disabled'}</option>
                  <option value="auto">{zh ? '可用时自动' : 'Auto when available'}</option>
                  <option value="required">{zh ? '必须可用' : 'Required'}</option>
                </select>
              </span>
            </label>
          </div>
        </section>

        <details className="computer-use-panel computer-use-panel--advanced" aria-labelledby="computer-use-jev-heading">
          <summary className="computer-use-advanced-summary">{zh ? '高级配置 · Jev 辅助' : 'Advanced settings · Jev assistance'}</summary>
          <fieldset disabled={saving || !enabled} className="computer-use-fieldset">
          <div className="computer-use-panel__header">
            <div>
              <div className="computer-use-panel__title-row">
                <h3 id="computer-use-jev-heading">{zh ? 'Jev 辅助' : 'Jev assistance'}</h3>
                <span className="computer-use-chip">{zh ? '可选' : 'Optional'}</span>
              </div>
              <p>{zh ? '在需要时使用外部视觉模型辅助决策。' : 'Use an external visual model to assist decisions when needed.'}</p>
            </div>
            <input className="computer-use-switch" type="checkbox" checked={jev.enabled === true} disabled={saving || !enabled} aria-label={zh ? '启用 Jev 辅助' : 'Enable Jev assistance'} onChange={e => void save({ ...current, jev: { ...jev, enabled: e.target.checked, fallback: jev.fallback ?? 'fail_closed' }, strategy: !e.target.checked && current.strategy === 'jev' ? 'auto' : current.strategy })} />
          </div>
          {jev.enabled === true ? (
            <div className="computer-use-rows">
              <label className="computer-use-row">
                <span className="computer-use-field-copy">
                  <span className="computer-use-field-title">{zh ? '失败时的处理' : 'Failure behavior'}</span>
                  <span className="computer-use-field-description">{zh ? '安全默认会停止操作。' : 'The safe default stops desktop actions.'}</span>
                </span>
                <span className="computer-use-control">
                  <select className="computer-use-select" aria-label={zh ? 'Jev 失败策略' : 'Jev failure policy'} value={jev.fallback ?? 'fail_closed'} disabled={saving || !enabled} onChange={e => void save(withJev({ fallback: e.target.value as Jev['fallback'] }))}>
                    <option value="fail_closed">{zh ? '停止操作' : 'Stop actions'}</option>
                    <option value="direct">{zh ? '允许直接使用 Cua' : 'Allow Direct Cua'}</option>
                  </select>
                </span>
              </label>
              <label className="computer-use-row">
                <span className="computer-use-field-copy">
                  <span className="computer-use-field-title">{zh ? '供应商' : 'Provider'}</span>
                  <span className="computer-use-field-description">{zh ? '留空则直接调用 TypeSafe（使用 TYPESAFE_API_KEY）。选择 OpenRouter 连接后，其 Base URL 填 https://openrouter.ai/api/v1 即可，内部会归一化为 https://openrouter.ai/api。' : 'Leave empty to call TypeSafe directly (TYPESAFE_API_KEY). An OpenRouter connection base URL of https://openrouter.ai/api/v1 is normalized to https://openrouter.ai/api.'}</span>
                </span>
                <span className="computer-use-control">
                  <select className="computer-use-select" aria-label={zh ? 'Jev 供应商' : 'Jev provider'} value={jev.providerId ?? ''} disabled={saving || !enabled} onChange={e => void save(withJev({ providerId: e.target.value || null }))}>
                    <option value="">{zh ? '未设置' : 'Not set'}</option>
                    {jevProviderOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                  </select>
                </span>
              </label>
              {!hasOpenRouter && onConfigureProvider ? (
                <div className="computer-use-row computer-use-row--key">
                  <div className="computer-use-field-copy">
                    <span className="computer-use-field-title">{zh ? '需要 OpenRouter？' : 'Need OpenRouter?'}</span>
                    <span className="computer-use-field-description">{zh ? '先在供应商设置中添加 OpenRouter 连接，配置完成后它才会出现在上面的列表中。' : 'Add an OpenRouter connection in Provider settings first. It will appear in the list above after it is configured.'}</span>
                  </div>
                  <div className="computer-use-button-group">
                    <button type="button" className="computer-use-button computer-use-button--ghost" disabled={saving || !enabled} onClick={onConfigureProvider}>
                      {zh ? '配置 OpenRouter' : 'Configure OpenRouter'}
                    </button>
                  </div>
                </div>
              ) : null}
              <label className="computer-use-row">
                <span className="computer-use-field-copy">
                  <span className="computer-use-field-title">{zh ? '模型' : 'Model'}</span>
                  <span className="computer-use-field-description">{zh ? 'System One 模型 ID，例如 jev-1.13、typesafe/jev-1.13 或 ~typesafe/jev-latest；留空使用默认 jev-latest。请勿填写 chat 模型 ID。' : 'A System One model id such as jev-1.13, typesafe/jev-1.13, or ~typesafe/jev-latest; empty keeps the default jev-latest. Do not use a chat model id.'}</span>
                </span>
                <span className="computer-use-control">
                  <input className="computer-use-input" type="text" aria-label={zh ? 'Jev 模型' : 'Jev model'} defaultValue={jev.model ?? ''} disabled={saving || !enabled} onBlur={e => { const next = e.target.value.trim(); if (next !== (jev.model ?? '')) void save(withJev({ model: next || null })) }} />
                </span>
              </label>
              <div className="computer-use-row computer-use-row--key">
                <div className="computer-use-field-copy">
                  <span className="computer-use-field-title"><KeyRound size={14} aria-hidden="true" />{zh ? 'API 密钥' : 'API key'}</span>
                  <span className="computer-use-field-description">{saved ? (zh ? `已保存：${saved}` : `Stored: ${saved}`) : jev.providerId ? (zh ? '已选择供应商，将优先使用该连接的 API 密钥。' : 'A provider is selected; its connection API key is used first.') : (zh ? '未保存，将回退到 TYPESAFE_API_KEY。' : 'Not stored; falls back to TYPESAFE_API_KEY.')}</span>
                </div>
                <div className="computer-use-key-control">
                  <input className="computer-use-input" type="password" aria-label={zh ? 'Jev API 密钥' : 'Jev API key'} placeholder={saved ? (zh ? '输入新密钥以替换' : 'Enter a replacement') : (zh ? '粘贴 API 密钥' : 'Paste API key')} value={keyDraft} disabled={saving || !enabled} onChange={e => setKeyDraft(e.target.value)} />
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
          </fieldset>
        </details>

        {error ? <div className="computer-use-form-error" role="alert"><AlertTriangle size={15} aria-hidden="true" />{error}</div> : null}
      </div>
    </SettingsCard>
  )
}
