import { Button, Card, Chip, Input } from '@heroui/react'
import { ChevronDown, ChevronRight, Eye, EyeOff, Loader2, RefreshCw, Save, ShieldCheck, Trash2, Wifi } from 'lucide-react'
import { type ApiProviderDraft, PROVIDER_LOGO_ASSETS } from '../lib/providerPresets'
import { validateProviderDraft } from '../lib/validation'
import { useShellStore } from '../../../state/shellStore'
import { useLocale } from '../../../../hooks/useLocale'
import { SettingsSelect } from './SettingsSelect'
import type { ApiFormat } from '../../../../lib/contracts/config'

interface LlmProviderCardProps {
  draft: ApiProviderDraft
  isDefault: boolean
  isSaved: boolean
  saving: boolean
  expanded: boolean
  onToggleExpand: () => void
  onChange: (updated: ApiProviderDraft) => void
  onSave: () => void
  onSetDefault: () => void
  onRemove: () => void
  onValidate: () => void
  onDiscoverModels: () => void
}

export function LlmProviderCard({
  draft,
  isDefault,
  isSaved,
  saving,
  expanded,
  onToggleExpand,
  onChange,
  onSave,
  onSetDefault,
  onRemove,
  onValidate,
  onDiscoverModels,
}: LlmProviderCardProps) {
  const theme = useShellStore(s => s.preferences.theme)
  const { t } = useLocale()
  const errors = expanded ? validateProviderDraft(draft) : []
  const fieldError = (field: string) => errors.find(e => e.field === field)?.message

  const logo = PROVIDER_LOGO_ASSETS[draft.id]

  return (
    <Card variant="transparent" className="overflow-hidden border border-border/50">
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
            {isDefault && <Chip size="sm" variant="flat" color="primary" className="h-4 text-[9px]">{t('llmCardDefault')}</Chip>}
          </div>
          <div className="text-[11px] text-muted-foreground truncate">{draft.model}</div>
        </div>
        <StatusDot validating={draft.validating || saving} hasKey={isSaved} />
        {expanded ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronRight size={14} className="text-muted-foreground" />}
      </button>

      {/* Expanded edit form */}
      {expanded && (
        <div className="border-t border-border/30 p-3 space-y-3">
          {/* API Key */}
          <Input
            size="sm"
            variant="bordered"
            label="API Key"
            labelPlacement="outside"
            type={draft.showApiKey ? 'text' : 'password'}
            placeholder={draft.apiKeyMasked || t('llmCardApiKeyPlaceholder')}
            value={draft.apiKey}
            onValueChange={(val) => onChange({ ...draft, apiKey: val })}
            isInvalid={!!fieldError('apiKey')}
            errorMessage={fieldError('apiKey')}
            endContent={
              <button
                type="button"
                className="text-muted-foreground/50 hover:text-muted-foreground"
                onClick={() => onChange({ ...draft, showApiKey: !draft.showApiKey })}
              >
                {draft.showApiKey ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            }
          />

          {/* API Format */}
          {draft.custom && (
            <SettingsSelect
              label="API Format"
              selectedKeys={[draft.format]}
              onSelectionChange={(keys) => {
                const val = [...keys][0] as string
                if (val) onChange({ ...draft, format: val as ApiFormat })
              }}
              disallowEmptySelection
              options={[
                { key: 'openai', label: 'OpenAI Chat Completions' },
                { key: 'openai-responses', label: 'OpenAI Responses' },
                { key: 'anthropic', label: 'Anthropic Messages' },
              ]}
            />
          )}

          {/* Base URL */}
          <Input
            size="sm"
            variant="bordered"
            label="Base URL"
            labelPlacement="outside"
            placeholder={draft.custom ? 'https://api.example.com' : undefined}
            value={draft.baseUrl}
            onValueChange={(val) => onChange({ ...draft, baseUrl: val })}
            isInvalid={!!fieldError('baseUrl')}
            errorMessage={fieldError('baseUrl')}
            isDisabled={!draft.custom}
            description={draft.custom && !fieldError('baseUrl') ? '无需包含 /v1，系统会自动检测' : undefined}
          />

          {/* Model */}
          <div className="space-y-1">
            <div className="flex gap-1.5 items-end">
              {draft.models.length > 1 ? (
                <SettingsSelect
                  label={t('llmCardModel')}
                  className="flex-1"
                  selectedKeys={[draft.model]}
                  onSelectionChange={(keys) => {
                    const val = [...keys][0] as string
                    if (val) onChange({ ...draft, model: val })
                  }}
                  disallowEmptySelection
                  options={draft.models.map(m => ({ key: m, label: m }))}
                />
              ) : (
                <Input
                  size="sm"
                  variant="bordered"
                  label={t('llmCardModel')}
                  labelPlacement="outside"
                  className="flex-1"
                  value={draft.model}
                  onValueChange={(val) => onChange({ ...draft, model: val })}
                  isInvalid={!!fieldError('model')}
                  errorMessage={fieldError('model')}
                />
              )}
              <Button
                size="sm"
                variant="bordered"
                isLoading={draft.discoveringModels}
                onPress={onDiscoverModels}
                startContent={!draft.discoveringModels ? <RefreshCw size={12} /> : undefined}
              >
                {t('llmCardDiscover')}
              </Button>
            </div>
            {draft.modelMessage && <div className="text-[10px] text-muted-foreground">{draft.modelMessage}</div>}
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="sm" color="primary" isLoading={saving} isDisabled={draft.validating} onPress={onSave} startContent={!saving ? <Save size={12} /> : undefined}>
              {t('llmCardSave')}
            </Button>
            <Button size="sm" variant="bordered" isLoading={draft.validating} onPress={onValidate} startContent={!draft.validating ? <Wifi size={12} /> : undefined}>
              {t('llmCardValidate')}
            </Button>
            {isSaved && !isDefault && (
              <Button size="sm" variant="bordered" onPress={onSetDefault} startContent={<ShieldCheck size={12} />}>
                {t('llmCardSetDefault')}
              </Button>
            )}
            <Button size="sm" variant="bordered" color="danger" onPress={onRemove} startContent={<Trash2 size={12} />}>
              {t('llmCardDelete')}
            </Button>
          </div>
          {draft.validationMessage && (
            <div className={`text-[11px] ${draft.validationMessage.startsWith('✓') ? 'text-success' : 'text-destructive'}`}>
              {draft.validationMessage}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

function StatusDot({ validating, hasKey }: { validating: boolean; hasKey: boolean }) {
  if (validating) return <Loader2 size={12} className="animate-spin text-muted-foreground" />
  return (
    <div className={`h-2 w-2 rounded-full ${hasKey ? 'bg-success' : 'bg-muted-foreground/30'}`} />
  )
}