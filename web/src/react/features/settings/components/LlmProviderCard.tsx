import { useState } from 'react'
import { ChevronDown, ChevronRight, Eye, EyeOff, Loader2, RefreshCw, ShieldCheck, Trash2, Wifi, WifiOff } from 'lucide-react'
import { type ApiProviderDraft, PROVIDER_LOGO_ASSETS } from '../lib/providerPresets'
import { validateProviderDraft } from '../lib/validation'
import { useShellStore } from '../../../state/shellStore'

interface LlmProviderCardProps {
  draft: ApiProviderDraft
  isDefault: boolean
  expanded: boolean
  onToggleExpand: () => void
  onChange: (updated: ApiProviderDraft) => void
  onSetDefault: () => void
  onRemove: () => void
  onValidate: () => void
  onDiscoverModels: () => void
}

export function LlmProviderCard({
  draft,
  isDefault,
  expanded,
  onToggleExpand,
  onChange,
  onSetDefault,
  onRemove,
  onValidate,
  onDiscoverModels,
}: LlmProviderCardProps) {
  const theme = useShellStore(s => s.preferences.theme)
  const errors = expanded ? validateProviderDraft(draft) : []
  const fieldError = (field: string) => errors.find(e => e.field === field)?.message

  const logo = PROVIDER_LOGO_ASSETS[draft.id]

  return (
    <div className="rounded-lg border border-border/50 bg-background/40 overflow-hidden">
      {/* Collapsed header */}
      <button
        type="button"
        className="flex w-full items-center gap-3 p-3 text-left transition hover:bg-secondary/30"
        onClick={onToggleExpand}
      >
        {logo ? (
          <img
            src={logo.src}
            alt={draft.label}
            className={`h-5 w-5 rounded object-contain${logo.invertOnDark && theme === 'dark' ? ' invert' : ''}`}
          />
        ) : (
          <div className="flex h-5 w-5 items-center justify-center rounded bg-muted text-[10px] font-bold text-muted-foreground">
            {draft.label[0]?.toUpperCase()}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-foreground truncate">{draft.label}</span>
            {isDefault && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary">默认</span>}
          </div>
          <div className="text-[11px] text-muted-foreground truncate">{draft.model}</div>
        </div>
        <StatusDot validating={draft.validating} hasKey={Boolean(draft.apiKey || draft.apiKeyMasked)} />
        {expanded ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronRight size={14} className="text-muted-foreground" />}
      </button>

      {/* Expanded edit form */}
      {expanded && (
        <div className="border-t border-border/30 p-3 space-y-3">
          {/* API Key */}
          <div>
            <label className="text-[11px] font-medium text-muted-foreground">API Key</label>
            <div className="relative mt-1">
              <input
                type={draft.showApiKey ? 'text' : 'password'}
                className={`settings-input pr-8${fieldError('apiKey') ? ' border-destructive' : ''}`}
                placeholder={draft.apiKeyMasked || '输入 API Key'}
                value={draft.apiKey}
                onChange={e => onChange({ ...draft, apiKey: e.target.value })}
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground"
                onClick={() => onChange({ ...draft, showApiKey: !draft.showApiKey })}
              >
                {draft.showApiKey ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            {fieldError('apiKey') && <div className="text-[10px] text-destructive mt-0.5">{fieldError('apiKey')}</div>}
          </div>

          {/* Base URL */}
          <div>
            <label className="text-[11px] font-medium text-muted-foreground">Base URL</label>
            <input
              type="text"
              className={`settings-input mt-1${fieldError('baseUrl') ? ' border-destructive' : ''}`}
              value={draft.baseUrl}
              onChange={e => onChange({ ...draft, baseUrl: e.target.value })}
            />
            {fieldError('baseUrl') && <div className="text-[10px] text-destructive mt-0.5">{fieldError('baseUrl')}</div>}
          </div>

          {/* Model */}
          <div>
            <label className="text-[11px] font-medium text-muted-foreground">模型</label>
            <div className="flex gap-1.5 mt-1">
              {draft.models.length > 1 ? (
                <select
                  className="settings-select flex-1"
                  value={draft.model}
                  onChange={e => onChange({ ...draft, model: e.target.value })}
                >
                  {draft.models.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              ) : (
                <input
                  type="text"
                  className={`settings-input flex-1${fieldError('model') ? ' border-destructive' : ''}`}
                  value={draft.model}
                  onChange={e => onChange({ ...draft, model: e.target.value })}
                />
              )}
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-50"
                onClick={onDiscoverModels}
                disabled={draft.discoveringModels}
              >
                {draft.discoveringModels ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                发现
              </button>
            </div>
            {draft.modelMessage && <div className="text-[10px] text-muted-foreground mt-0.5">{draft.modelMessage}</div>}
            {fieldError('model') && <div className="text-[10px] text-destructive mt-0.5">{fieldError('model')}</div>}
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-50"
              onClick={onValidate}
              disabled={draft.validating}
            >
              {draft.validating ? <Loader2 size={11} className="animate-spin" /> : <Wifi size={11} />}
              验证连接
            </button>
            {!isDefault && (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-muted"
                onClick={onSetDefault}
              >
                <ShieldCheck size={11} />
                设为默认
              </button>
            )}
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-[11px] text-destructive hover:bg-destructive/10"
              onClick={onRemove}
            >
              <Trash2 size={11} />
              删除
            </button>
          </div>
          {draft.validationMessage && (
            <div className={`text-[11px] ${draft.validationMessage.startsWith('✓') ? 'text-success' : 'text-destructive'}`}>
              {draft.validationMessage}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StatusDot({ validating, hasKey }: { validating: boolean; hasKey: boolean }) {
  if (validating) return <Loader2 size={12} className="animate-spin text-muted-foreground" />
  return (
    <div className={`h-2 w-2 rounded-full ${hasKey ? 'bg-success' : 'bg-muted-foreground/30'}`} />
  )
}
