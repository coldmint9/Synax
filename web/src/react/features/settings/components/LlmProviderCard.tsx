import { Button, Card, Chip } from '@heroui/react'
import { ChevronDown, ChevronRight, Loader2, Pencil, ShieldCheck, Trash2 } from 'lucide-react'
import { type ApiProviderDraft, PROVIDER_LOGO_ASSETS } from '../lib/providerPresets'
import { ProviderLogo } from '../../../components/ProviderLogo'
import { IconSurface } from '../../../components/IconSurface'
import { useLocale } from '../../../../hooks/useLocale'

interface LlmProviderCardProps {
  draft: ApiProviderDraft
  isDefault: boolean
  isSaved: boolean
  saving: boolean
  expanded: boolean
  onToggleExpand: () => void
  onEdit: () => void
  onSetDefault: () => void
  onRemove: () => void
}

export function LlmProviderCard({
  draft,
  isDefault,
  isSaved,
  saving,
  expanded,
  onToggleExpand,
  onEdit,
  onSetDefault,
  onRemove,
}: LlmProviderCardProps) {
  const { t } = useLocale()
  const logo = PROVIDER_LOGO_ASSETS[draft.id]

  return (
    <Card variant="transparent" className="overflow-hidden border border-border/50">
      <button
        type="button"
        className="flex w-full items-center gap-3 p-3 text-left transition hover:bg-secondary/30"
        onClick={onToggleExpand}
      >
        {logo ? (
          <ProviderLogo src={logo.src} alt={draft.label} invertOnDark={logo.invertOnDark} />
        ) : (
          <IconSurface tone="muted" size="xs">
            <span className="text-[10px] font-bold">{draft.label[0]?.toUpperCase()}</span>
          </IconSurface>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-foreground truncate">{draft.label}</span>
            {isDefault && (
              <Chip size="sm" color="accent" variant="soft" className="h-4 text-[9px]">
                <Chip.Label>{t('llmCardDefault')}</Chip.Label>
              </Chip>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground truncate">{draft.model}</div>
        </div>
        <StatusDot validating={draft.validating || saving} hasKey={isSaved} />
        {expanded ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronRight size={14} className="text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="border-t border-border/30 p-3 space-y-2">
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[11px]">
            <span className="text-muted-foreground">API Key</span>
            <span className="text-foreground font-mono truncate">
              {draft.apiKeyMasked || (draft.apiKey ? '••••••••' : '—')}
            </span>
            <span className="text-muted-foreground">Base URL</span>
            <span className="text-foreground font-mono truncate">{draft.baseUrl || '—'}</span>
            {draft.custom && (
              <>
                <span className="text-muted-foreground">Format</span>
                <span className="text-foreground">{formatLabel(draft.format)}</span>
              </>
            )}
            <span className="text-muted-foreground">{t('llmCardModel')}</span>
            <span className="text-foreground font-mono truncate">{draft.model || '—'}</span>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" variant="secondary" onPress={onEdit}>
              <Pencil size={12} />
              编辑
            </Button>
            {isSaved && !isDefault && (
              <Button size="sm" variant="secondary" onPress={onSetDefault}>
                <ShieldCheck size={12} />
                {t('llmCardSetDefault')}
              </Button>
            )}
            <Button size="sm" variant="danger-soft" onPress={onRemove}>
              <Trash2 size={12} />
              {t('llmCardDelete')}
            </Button>
          </div>
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

function formatLabel(format: string): string {
  switch (format) {
    case 'openai': return 'OpenAI Chat Completions'
    case 'openai-responses': return 'OpenAI Responses'
    case 'anthropic': return 'Anthropic Messages'
    default: return format
  }
}
