import { Square, ArrowUp } from 'lucide-react'
import { Button, Input } from '@heroui/react'
import type { ProviderDef } from '../../../../lib/contracts/config'
import type { GlobalConfig } from '../../../../lib/contracts/config'
import type { WikiDocument } from '../../../../lib/contracts/wiki'
import { useLocale } from '../../../../hooks/useLocale'
import { GoalAttachMenu } from './GoalAttachMenu'
import { GoalModelPicker } from './GoalModelPicker'
import type { GoalModelSelection } from './goalModelOptions'
import type { GoalPermissionAction, GoalPermissionGate, GoalWikiAttachMode } from './goalAttachTypes'

interface Props {
  content: string
  onContentChange: (value: string) => void
  onSubmit: () => void
  onStop?: () => void
  isGenerating?: boolean
  providerId: string | null
  modelId: string | null
  onModelSelect: (selection: GoalModelSelection) => void
  providers: ProviderDef[]
  globalConfig: GlobalConfig | null
  documentId: string | null
  onDocumentChange: (id: string | null) => void
  wikiAttachMode: GoalWikiAttachMode
  onWikiAttachModeChange: (mode: GoalWikiAttachMode) => void
  documents: WikiDocument[]
  skillIds: string[]
  onSkillIdsChange: (ids: string[]) => void
  permissions: Partial<Record<GoalPermissionGate, GoalPermissionAction>> | null
  onPermissionChange: (gate: GoalPermissionGate, action: GoalPermissionAction) => void
  disabled?: boolean
  onOverlayOpenChange?: (open: boolean) => void
}

export function GoalComposerPill({
  content,
  onContentChange,
  onSubmit,
  onStop,
  isGenerating = false,
  providerId,
  modelId,
  onModelSelect,
  providers,
  globalConfig,
  documentId,
  onDocumentChange,
  wikiAttachMode,
  onWikiAttachModeChange,
  documents,
  skillIds,
  onSkillIdsChange,
  permissions,
  onPermissionChange,
  disabled,
  onOverlayOpenChange,
}: Props) {
  const { t } = useLocale()

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
    e.preventDefault()
    if (!disabled && !isGenerating && content.trim()) onSubmit()
  }

  return (
    <div className="goal-dock-composer flex h-11 w-full items-center gap-1.5 px-1.5 pl-2.5">
      <GoalAttachMenu
        documentId={documentId}
        onDocumentChange={onDocumentChange}
        wikiAttachMode={wikiAttachMode}
        onWikiAttachModeChange={onWikiAttachModeChange}
        documents={documents}
        skillIds={skillIds}
        onSkillIdsChange={onSkillIdsChange}
        permissions={permissions}
        onPermissionChange={onPermissionChange}
        disabled={disabled}
        onOverlayOpenChange={onOverlayOpenChange}
      />

      <Input
        value={content}
        onChange={(e) => onContentChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('goalPlaceholder')}
        aria-label={t('goalPlaceholder')}
        disabled={disabled}
        className="min-w-0 flex-1 border-0 bg-transparent px-0 text-[13px] shadow-none focus-visible:ring-0"
      />

      <GoalModelPicker
        globalConfig={globalConfig}
        providers={providers}
        providerId={providerId}
        modelId={modelId}
        onSelect={onModelSelect}
        disabled={disabled}
        onOverlayOpenChange={onOverlayOpenChange}
      />

      {isGenerating ? (
        <Button
          isIconOnly
          variant="secondary"
          size="sm"
          aria-label={t('goalStop')}
          className="size-8 shrink-0 rounded-full"
          onPress={onStop}
        >
          <Square size={12} fill="currentColor" />
        </Button>
      ) : (
        <Button
          isIconOnly
          variant="primary"
          size="sm"
          aria-label={t('goalSend')}
          className="size-8 shrink-0 rounded-full"
          isDisabled={disabled || !content.trim()}
          onPress={onSubmit}
        >
          <ArrowUp size={15} />
        </Button>
      )}
    </div>
  )
}
