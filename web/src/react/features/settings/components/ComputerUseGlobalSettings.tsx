import { useState } from 'react'
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

export function ComputerUseGlobalSettings({ value, locale, onUpdate }: {
  value?: Config
  locale: string
  onUpdate: (patch: UpdateGlobalConfigRequest) => Promise<unknown>
}) {
  const zh = locale.startsWith('zh')
  const current = value ?? DEFAULT
  const jev: Jev = current.jev ?? {}
  const status = useComputerUseStatus()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState('')

  async function save(next: Config) {
    setSaving(true); setError(null)
    try { await onUpdate({ computerUse: next }); setKeyDraft('') }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setSaving(false) }
  }

  const withJev = (patch: Partial<Jev>): Config => ({ ...current, jev: { ...jev, ...patch } })
  const saved = jev.apiKeyMasked

  return (
    <SettingsCard
      title={zh ? '电脑操作' : 'Computer Use'}
      description={zh
        ? '这里的默认值对所有项目生效；单个项目可在项目设置中覆盖。'
        : 'These defaults apply to every project; a project can override them in its own settings.'}
    >
      <div className="space-y-3 text-sm">
        <p role="status">
          {zh ? '驱动状态' : 'Driver status'}: {status?.state ?? (zh ? '非桌面应用' : 'Not in desktop app')}
          {status?.error ? ` — ${status.error}` : ''}
        </p>
        {status?.error?.includes('Accessibility and Screen Recording') ? (
          <div className="flex gap-3">
            <button type="button" className="text-primary underline" onClick={() => openComputerUsePermission('accessibility')}>
              {zh ? '打开辅助功能设置' : 'Open Accessibility settings'}
            </button>
            <button type="button" className="text-primary underline" onClick={() => openComputerUsePermission('screen-recording')}>
              {zh ? '打开屏幕录制设置' : 'Open Screen Recording settings'}
            </button>
          </div>
        ) : null}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={current.enabled !== false} disabled={saving} onChange={e => void save({ ...current, enabled: e.target.checked })} />
          {zh ? '启用电脑操作' : 'Enable Computer Use'}
        </label>
        <label className="flex items-center gap-2">{zh ? '策略' : 'Strategy'}
          <select aria-label={zh ? '电脑操作策略' : 'Computer Use strategy'} value={current.strategy ?? 'auto'} disabled={saving || current.enabled === false} onChange={e => void save({ ...current, strategy: e.target.value as Config['strategy'] })}>
            <option value="auto">{zh ? '自动（默认直接使用 Cua）' : 'Auto (Direct Cua by default)'}</option>
            <option value="direct">Direct Cua</option>
            <option value="jev" disabled={jev.enabled !== true}>{zh ? 'Jev 辅助' : 'Jev assisted'}</option>
          </select>
        </label>
        <label className="flex items-center gap-2">{zh ? '视觉解析' : 'Visual perception'}
          <select aria-label={zh ? '视觉解析' : 'Visual perception'} value={current.perception ?? 'disabled'} disabled={saving || current.enabled === false} onChange={e => void save({ ...current, perception: e.target.value as Config['perception'] })}>
            <option value="disabled">{zh ? '关闭（默认）' : 'Disabled (default)'}</option>
            <option value="auto">{zh ? '可用时自动' : 'Auto when available'}</option>
            <option value="required">{zh ? '必须可用' : 'Required'}</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={jev.enabled === true} disabled={saving} onChange={e => void save({ ...current, jev: { ...jev, enabled: e.target.checked, fallback: jev.fallback ?? 'fail_closed' }, strategy: !e.target.checked && current.strategy === 'jev' ? 'auto' : current.strategy })} />
          {zh ? '启用 Jev 辅助' : 'Enable Jev assistance'}
        </label>
        {jev.enabled === true ? (
          <>
            <label className="flex items-center gap-2">{zh ? 'Jev 失败时' : 'If Jev fails'}
              <select aria-label={zh ? 'Jev 失败策略' : 'Jev failure policy'} value={jev.fallback ?? 'fail_closed'} disabled={saving} onChange={e => void save(withJev({ fallback: e.target.value as Jev['fallback'] }))}>
                <option value="fail_closed">{zh ? '停止操作（安全默认）' : 'Stop (safe default)'}</option>
                <option value="direct">{zh ? '允许直接使用 Cua 工具' : 'Allow Direct Cua tools'}</option>
              </select>
            </label>
            <label className="flex items-center gap-2">{zh ? 'Jev 供应商标识' : 'Jev provider id'}
              <input type="text" aria-label={zh ? 'Jev 供应商标识' : 'Jev provider id'} defaultValue={jev.providerId ?? ''} disabled={saving} onBlur={e => { const next = e.target.value.trim(); if (next !== (jev.providerId ?? '')) void save(withJev({ providerId: next || null })) }} />
            </label>
            <label className="flex items-center gap-2">{zh ? 'Jev 模型' : 'Jev model'}
              <input type="text" aria-label={zh ? 'Jev 模型' : 'Jev model'} defaultValue={jev.model ?? ''} disabled={saving} onBlur={e => { const next = e.target.value.trim(); if (next !== (jev.model ?? '')) void save(withJev({ model: next || null })) }} />
            </label>
            <label className="flex items-center gap-2">{zh ? 'Jev API 密钥' : 'Jev API key'}
              <input type="password" aria-label={zh ? 'Jev API 密钥' : 'Jev API key'} placeholder={saved ?? ''} value={keyDraft} disabled={saving} onChange={e => setKeyDraft(e.target.value)} />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="text-primary underline" disabled={saving || !keyDraft} onClick={() => void save(withJev({ apiKey: keyDraft }))}>{zh ? '保存密钥' : 'Save key'}</button>
              <button type="button" className="text-primary underline" disabled={saving || !saved} onClick={() => void save(withJev({ apiKey: '' }))}>{zh ? '清除密钥' : 'Clear key'}</button>
              <span role="status">{saved ? (zh ? `已保存密钥：${saved}` : `Stored key: ${saved}`) : (zh ? '未保存密钥（将回退到环境变量 TYPESAFE_API_KEY）' : 'No stored key (falls back to TYPESAFE_API_KEY)')}</span>
            </div>
          </>
        ) : null}
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      </div>
    </SettingsCard>
  )
}
