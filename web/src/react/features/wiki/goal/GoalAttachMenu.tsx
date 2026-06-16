import { useCallback, useMemo, useRef, useState } from 'react'
import { BookOpen, Plug, Plus, Shield, Sparkles } from 'lucide-react'
import { Button, Dropdown, Header, Label } from '@heroui/react'
import type { WikiDocument } from '../../../../lib/contracts/wiki'
import { agentRuntimeApi, type AgentSkillSummary } from '../../../../lib/api/agentRuntime'
import { useLocale } from '../../../../hooks/useLocale'
import {
  GOAL_PERMISSION_DEFAULTS,
  GOAL_PERMISSION_GATES,
  GOAL_PROFILE_ID,
  hasGoalPermissionOverrides,
  type GoalPermissionAction,
  type GoalPermissionGate,
} from './goalAttachTypes'

interface Props {
  documentId: string | null
  onDocumentChange: (id: string | null) => void
  documents: WikiDocument[]
  skillIds: string[]
  onSkillIdsChange: (ids: string[]) => void
  permissions: Partial<Record<GoalPermissionGate, GoalPermissionAction>> | null
  onPermissionChange: (gate: GoalPermissionGate, action: GoalPermissionAction) => void
  disabled?: boolean
  onOverlayOpenChange?: (open: boolean) => void
}

function AttachBadge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className="ms-auto rounded-full bg-amber-500/15 px-1.5 py-px text-[9px] font-medium text-amber-700 dark:text-amber-300">
      {count}
    </span>
  )
}

const GATE_LABEL_KEYS = {
  read: 'goalPermGateRead',
  write: 'goalPermGateWrite',
  shell: 'goalPermGateShell',
  task: 'goalPermGateTask',
} as const satisfies Record<GoalPermissionGate, 'goalPermGateRead' | 'goalPermGateWrite' | 'goalPermGateShell' | 'goalPermGateTask'>

const ACTION_LABEL_KEYS = {
  allow: 'goalPermAllow',
  ask: 'goalPermAsk',
  deny: 'goalPermDeny',
} as const

function PermissionPanel({
  permissions,
  onPermissionChange,
}: {
  permissions: Partial<Record<GoalPermissionGate, GoalPermissionAction>> | null
  onPermissionChange: (gate: GoalPermissionGate, action: GoalPermissionAction) => void
}) {
  const { t } = useLocale()

  return (
    <div className="w-56 space-y-2.5 p-2.5">
      {GOAL_PERMISSION_GATES.map(gate => {
        const current = permissions?.[gate] ?? GOAL_PERMISSION_DEFAULTS[gate]
        return (
          <div key={gate}>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {t(GATE_LABEL_KEYS[gate])}
            </div>
            <div className="flex gap-1">
              {(['allow', 'ask', 'deny'] as const).map(action => (
                <Button
                  key={action}
                  size="sm"
                  variant={current === action ? 'primary' : 'tertiary'}
                  className="h-6 min-w-0 flex-1 px-1.5 text-[10px]"
                  onPress={() => onPermissionChange(gate, action)}
                >
                  {t(ACTION_LABEL_KEYS[action])}
                </Button>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function GoalAttachMenu({
  documentId,
  onDocumentChange,
  documents,
  skillIds,
  onSkillIdsChange,
  permissions,
  onPermissionChange,
  disabled,
  onOverlayOpenChange,
}: Props) {
  const { t } = useLocale()
  const [skills, setSkills] = useState<AgentSkillSummary[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const skillsLoadedRef = useRef(false)
  const skillsLoadingRef = useRef(false)

  const loadSkills = useCallback(() => {
    if (skillsLoadedRef.current || skillsLoadingRef.current) return
    skillsLoadingRef.current = true
    setSkillsLoading(true)
    void agentRuntimeApi
      .listSkills(GOAL_PROFILE_ID)
      .then(res => {
        skillsLoadedRef.current = true
        setSkills(res.items.filter(s => s.status === 'available'))
      })
      .catch(() => {
        skillsLoadedRef.current = true
        setSkills([])
      })
      .finally(() => {
        skillsLoadingRef.current = false
        setSkillsLoading(false)
      })
  }, [])

  const handleOpenChange = useCallback((open: boolean) => {
    onOverlayOpenChange?.(open)
    if (open) loadSkills()
  }, [loadSkills, onOverlayOpenChange])

  const hasAttachments = useMemo(
    () => Boolean(documentId) || skillIds.length > 0 || hasGoalPermissionOverrides(permissions),
    [documentId, skillIds.length, permissions],
  )

  return (
    <Dropdown onOpenChange={handleOpenChange}>
      <Dropdown.Trigger>
        <Button
          isIconOnly
          variant="tertiary"
          size="sm"
          aria-label={t('goalAttach')}
          className={`relative size-7 shrink-0 rounded-full${hasAttachments ? ' text-amber-600' : ''}`}
          isDisabled={disabled}
        >
          <Plus size={14} />
          {hasAttachments && (
            <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-background" />
          )}
        </Button>
      </Dropdown.Trigger>
      <Dropdown.Popover placement="top start" className="z-50">
        <Dropdown.Menu aria-label={t('goalAttach')}>
          <Dropdown.SubmenuTrigger>
            <Dropdown.Item id="wiki" textValue={t('goalAttachWiki')}>
              <BookOpen size={14} className="shrink-0 text-muted-foreground/70" />
              <Label>{t('goalAttachWiki')}</Label>
              {documentId && <AttachBadge count={1} />}
              <Dropdown.SubmenuIndicator />
            </Dropdown.Item>
            <Dropdown.Popover>
              <Dropdown.Menu
                aria-label={t('goalWikiContext')}
                selectedKeys={new Set([documentId ?? '__none__'])}
                selectionMode="single"
                onSelectionChange={(keys) => {
                  const key = [...keys][0]
                  if (key) onDocumentChange(String(key) === '__none__' ? null : String(key))
                }}
              >
                <Dropdown.Section>
                  <Header>{t('goalWikiContext')}</Header>
                  <Dropdown.Item id="__none__" textValue={t('goalWikiNone')}>
                    <Label>{t('goalWikiNone')}</Label>
                  </Dropdown.Item>
                  {documents.map(doc => (
                    <Dropdown.Item key={doc.id} id={doc.id} textValue={doc.title}>
                      <Label className="truncate">{doc.title}</Label>
                    </Dropdown.Item>
                  ))}
                </Dropdown.Section>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.SubmenuTrigger>

          <Dropdown.SubmenuTrigger>
            <Dropdown.Item id="mcp" textValue={t('goalAttachMcp')}>
              <Plug size={14} className="shrink-0 text-muted-foreground/70" />
              <Label>{t('goalAttachMcp')}</Label>
              <Dropdown.SubmenuIndicator />
            </Dropdown.Item>
            <Dropdown.Popover>
              <div className="max-w-52 p-3">
                <p className="text-[11px] font-medium text-foreground">{t('settingsMcpTitle')}</p>
                <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                  {t('settingsMcpDesc')}
                </p>
                <span className="mt-2 inline-block rounded-full bg-muted px-2 py-0.5 text-[9px] text-muted-foreground">
                  {t('settingsMcpComingSoon')}
                </span>
              </div>
            </Dropdown.Popover>
          </Dropdown.SubmenuTrigger>

          <Dropdown.SubmenuTrigger>
            <Dropdown.Item id="skills" textValue={t('goalAttachSkills')}>
              <Sparkles size={14} className="shrink-0 text-muted-foreground/70" />
              <Label>{t('goalAttachSkills')}</Label>
              <AttachBadge count={skillIds.length} />
              <Dropdown.SubmenuIndicator />
            </Dropdown.Item>
            <Dropdown.Popover>
              {skillsLoading ? (
                <div className="px-3 py-2 text-[10px] text-muted-foreground">{t('goalAttachSkillsLoading')}</div>
              ) : skills.length === 0 ? (
                <div className="px-3 py-2 text-[10px] text-muted-foreground">{t('goalAttachSkillsEmpty')}</div>
              ) : (
                <Dropdown.Menu
                  aria-label={t('goalAttachSkills')}
                  selectedKeys={new Set(skillIds)}
                  selectionMode="multiple"
                  onSelectionChange={(keys) => onSkillIdsChange([...keys].map(String))}
                >
                  <Dropdown.Section>
                    <Header>{t('goalAttachSkills')}</Header>
                    {skills.map(skill => (
                      <Dropdown.Item key={skill.id} id={skill.id} textValue={skill.label}>
                        <Label className="truncate">{skill.label}</Label>
                      </Dropdown.Item>
                    ))}
                  </Dropdown.Section>
                </Dropdown.Menu>
              )}
            </Dropdown.Popover>
          </Dropdown.SubmenuTrigger>

          <Dropdown.SubmenuTrigger>
            <Dropdown.Item id="permissions" textValue={t('goalAttachPermissions')}>
              <Shield size={14} className="shrink-0 text-muted-foreground/70" />
              <Label>{t('goalAttachPermissions')}</Label>
              {hasGoalPermissionOverrides(permissions) && <AttachBadge count={1} />}
              <Dropdown.SubmenuIndicator />
            </Dropdown.Item>
            <Dropdown.Popover>
              <PermissionPanel permissions={permissions} onPermissionChange={onPermissionChange} />
            </Dropdown.Popover>
          </Dropdown.SubmenuTrigger>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}
