import { useCallback, useMemo, useRef, useState } from 'react'
import { BookOpen, Check, Plus, Sparkles } from 'lucide-react'
import { Dropdown, Header, Label, Switch } from '@heroui/react'
import type { WikiDocument } from '../../../../lib/contracts/wiki'
import { skillsApi, type SkillSummary } from '../../../../lib/api/skills'
import { useLocale } from '../../../../hooks/useLocale'
import {
  SYNAX_PROFILE_ID,
  type GoalWikiAttachMode,
} from './goalAttachTypes'

interface Props {
  projectId: string
  documentId: string | null
  onDocumentChange: (id: string | null) => void
  wikiAttachMode: GoalWikiAttachMode
  onWikiAttachModeChange: (mode: GoalWikiAttachMode) => void
  documents: WikiDocument[]
  skillIds: string[]
  onSkillIdsChange: (ids: string[]) => void
  disabled?: boolean
  /** Disable wiki attach controls only (skills/permissions stay editable). */
  skillsDisabled?: boolean
  wikiAttachDisabled?: boolean
  onOverlayOpenChange?: (open: boolean) => void
}

function AttachBadge({ count, label }: { count?: number; label?: string }) {
  if (label) {
    return (
      <span className="goal-attach-badge ms-auto rounded-full px-1.5 py-px text-[9px] font-medium uppercase tracking-wide">
        {label}
      </span>
    )
  }
  if (!count || count <= 0) return null
  return (
    <span className="goal-attach-badge ms-auto rounded-full px-1.5 py-px text-[9px] font-medium">
      {count}
    </span>
  )
}

function isGeneratedWikiDocument(doc: WikiDocument): boolean {
  return !doc.isSection && doc.contentMd.trim().length > 0
}

function WikiAttachPanel({
  documentId,
  onDocumentChange,
  wikiAttachMode,
  onWikiAttachModeChange,
  documents,
  disabled,
}: {
  documentId: string | null
  onDocumentChange: (id: string | null) => void
  wikiAttachMode: GoalWikiAttachMode
  onWikiAttachModeChange: (mode: GoalWikiAttachMode) => void
  documents: WikiDocument[]
  disabled?: boolean
}) {
  const { t } = useLocale()
  const isAuto = wikiAttachMode === 'auto'
  const generatedDocuments = useMemo(
    () => documents.filter(isGeneratedWikiDocument),
    [documents],
  )

  return (
    <div className={`w-56 py-1${disabled ? ' pointer-events-none opacity-60' : ''}`}>
      <div className="flex items-center justify-between gap-3 px-2.5 py-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-foreground">{t('goalWikiAuto')}</p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
            {isAuto ? t('goalWikiAutoOnDesc') : t('goalWikiAutoOffDesc')}
          </p>
        </div>
        <Switch
          size="sm"
          isSelected={isAuto}
          isDisabled={disabled}
          onChange={(selected) => onWikiAttachModeChange(selected ? 'auto' : 'manual')}
          aria-label={t('goalWikiAuto')}
        >
          <Switch.Control><Switch.Thumb /></Switch.Control>
        </Switch>
      </div>

      {!isAuto && (
        <Dropdown.Menu
          aria-label={t('goalWikiContext')}
          selectedKeys={new Set([documentId ?? '__none__'])}
          selectionMode="single"
          onSelectionChange={(keys) => {
            if (disabled) return
            const key = [...keys][0]
            if (key) onDocumentChange(String(key) === '__none__' ? null : String(key))
          }}
        >
          <Dropdown.Section>
            <Header>{t('goalWikiContext')}</Header>
            <Dropdown.Item id="__none__" textValue={t('goalWikiNone')}>
              {documentId === null
                ? <Check size={14} className="shrink-0 text-primary" />
                : <span className="size-3.5 shrink-0" aria-hidden />}
              <Label className={documentId === null ? 'font-medium text-primary' : ''}>
                {t('goalWikiNone')}
              </Label>
            </Dropdown.Item>
            {generatedDocuments.length === 0 ? (
              <div className="px-3 py-2 text-[10px] text-muted-foreground">
                {t('goalWikiGeneratedEmpty')}
              </div>
            ) : generatedDocuments.map(doc => (
              <Dropdown.Item key={doc.id} id={doc.id} textValue={doc.title}>
                {documentId === doc.id
                  ? <Check size={14} className="shrink-0 text-primary" />
                  : <span className="size-3.5 shrink-0" aria-hidden />}
                <Label className={`truncate ${documentId === doc.id ? 'font-medium text-primary' : ''}`}>
                  {doc.title}
                </Label>
              </Dropdown.Item>
            ))}
          </Dropdown.Section>
        </Dropdown.Menu>
      )}
    </div>
  )
}

export function GoalAttachMenu({
  projectId,
  documentId,
  onDocumentChange,
  wikiAttachMode,
  onWikiAttachModeChange,
  documents,
  skillIds,
  onSkillIdsChange,
  disabled,
  wikiAttachDisabled,
  skillsDisabled,
  onOverlayOpenChange,
}: Props) {
  const { t, locale } = useLocale()
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const skillsLoadedRef = useRef(false)
  const skillsLoadingRef = useRef(false)

  const loadSkills = useCallback(() => {
    if (skillsLoadedRef.current || skillsLoadingRef.current) return
    skillsLoadingRef.current = true
    setSkillsLoading(true)
    void skillsApi
      .list({ projectId, profileId: SYNAX_PROFILE_ID })
      .then((res) => {
        skillsLoadedRef.current = true
        setSkills(res.items.filter((skill) =>
          skill.status === 'available' && Boolean(skill.installPath),
        ))
      })
      .catch(() => {
        skillsLoadedRef.current = true
        setSkills([])
      })
      .finally(() => {
        skillsLoadingRef.current = false
        setSkillsLoading(false)
      })
  }, [projectId])

  const handleOpenChange = useCallback((open: boolean) => {
    onOverlayOpenChange?.(open)
    if (open) loadSkills()
  }, [loadSkills, onOverlayOpenChange])

  return (
    <Dropdown onOpenChange={handleOpenChange}>
      <Dropdown.Trigger
        isDisabled={disabled}
        aria-label={t('goalAttach')}
        className="button button--icon-only button--sm button--tertiary relative inline-flex size-7 shrink-0 items-center justify-center rounded-full p-0 text-foreground/80"
      >
        <Plus size={14} className="shrink-0" strokeWidth={2} />
      </Dropdown.Trigger>
      <Dropdown.Popover placement="top start" className="z-50">
        <Dropdown.Menu aria-label={t('goalAttach')}>
          <Dropdown.SubmenuTrigger>
            <Dropdown.Item id="wiki" textValue={t('goalAttachWiki')}>
              <BookOpen size={14} className="shrink-0 text-muted-foreground/70" />
              <Label>{t('goalAttachWiki')}</Label>
              {wikiAttachMode === 'auto'
                ? <AttachBadge label="auto" />
                : documentId
                  ? <AttachBadge count={1} />
                  : null}
              <Dropdown.SubmenuIndicator />
            </Dropdown.Item>
            <Dropdown.Popover>
              <WikiAttachPanel
                documentId={documentId}
                onDocumentChange={onDocumentChange}
                wikiAttachMode={wikiAttachMode}
                onWikiAttachModeChange={onWikiAttachModeChange}
                documents={documents}
                disabled={wikiAttachDisabled}
              />
            </Dropdown.Popover>
          </Dropdown.SubmenuTrigger>

          <Dropdown.Section>
            <Header>{t('goalAttachSkills')}</Header>
            {skillsDisabled ? (<div className="px-3 py-2 text-[10px] text-muted-foreground">{locale === 'zh' ? '此后端使用原生 Skills 配置。' : 'This backend uses its native Skills configuration.'}</div>) : skillsLoading ? (
              <div className="px-3 py-2 text-[10px] text-muted-foreground">{t('goalAttachSkillsLoading')}</div>
            ) : skills.length === 0 ? (
              <div className="px-3 py-2 text-[10px] text-muted-foreground">{t('goalAttachSkillsEmpty')}</div>
            ) : skills.map(skill => (
              <Dropdown.Item
                key={skill.id}
                id={skill.id}
                textValue={skill.label}
                onAction={() => {
                  const next = skillIds.includes(skill.id)
                    ? skillIds.filter(id => id !== skill.id)
                    : [...skillIds, skill.id]
                  onSkillIdsChange(next)
                }}
              >
                {skillIds.includes(skill.id)
                  ? <Check size={14} className="shrink-0 text-primary" />
                  : <span className="size-3.5 shrink-0" aria-hidden />}
                <Sparkles size={12} className="shrink-0 text-muted-foreground/60" />
                <Label className={`truncate ${skillIds.includes(skill.id) ? 'font-medium text-primary' : ''}`}>
                  {skill.label}
                </Label>
              </Dropdown.Item>
            ))}
          </Dropdown.Section>

        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}
