import { Button } from '@heroui/react'
import { Sparkles } from 'lucide-react'
import type { SkillSummary } from '../../../lib/api/skills'
import { useLocale } from '../../../hooks/useLocale'
import { ExtensionControls } from '../../components/extensions/ExtensionControls'

interface Props {
  skill: SkillSummary
  busy: boolean
  pending?: boolean
  onInstall: () => void
  onUninstall: () => void
  onToggle: (enabled: boolean) => void
}

export function SkillCard({
  skill,
  busy,
  pending,
  onInstall,
  onUninstall,
  onToggle,
}: Props) {
  const { t } = useLocale()
  const sourceLabels = {
    builtin: t('skillSourceBuiltin'),
    local: t('skillSourceLocal'),
    project: t('skillSourceProject'),
    remote: t('skillSourceRemote'),
  }
  return (
    <article
      className="flex min-h-[76px] items-center gap-3 rounded-xl border border-border/40 bg-card/30 px-4 py-3 transition-colors hover:bg-card/50"
      aria-busy={pending || undefined}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Sparkles size={17} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3
            className="truncate text-sm font-medium text-foreground"
            title={skill.label}
          >
            {skill.label}
          </h3>
          <span className="shrink-0 rounded bg-secondary/70 px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {sourceLabels[skill.sourceKind]}
          </span>
          {skill.version?.trim() && (
            <span
              className="hidden max-w-28 truncate text-xs text-muted-foreground md:inline"
              title={skill.version}
            >
              v{skill.version}
            </span>
          )}
        </div>
        <p
          className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground"
          title={skill.description}
        >
          {skill.description || skill.id}
        </p>
      </div>
      {skill.installed ? (
        <ExtensionControls
          name={skill.label}
          enabled={skill.status !== 'disabled'}
          busy={busy}
          onToggle={onToggle}
          actions={
            skill.installationId
              ? [
                  {
                    id: 'uninstall',
                    label: t('skillMarketUninstall'),
                    onAction: onUninstall,
                    danger: true,
                  },
                ]
              : []
          }
        />
      ) : skill.sourceKind === 'remote' ? (
        <Button
          size="sm"
          variant="secondary"
          isDisabled={busy}
          isPending={pending}
          onPress={onInstall}
        >
          {t('skillMarketInstall')}
        </Button>
      ) : null}
    </article>
  )
}
