import { Button } from '@heroui/react'
import { Sparkles } from 'lucide-react'
import type { SkillSummary } from '../../../lib/api/skills'

const SOURCE_KIND_LABEL: Record<SkillSummary['sourceKind'], string> = {
  builtin: 'Built-in',
  local: 'Local',
  project: 'Project',
  remote: 'Remote',
}

interface Props {
  skill: SkillSummary
  busy: boolean
  labels: {
    install: string
    uninstall: string
    installed: string
    available: string
  }
  onInstall: () => void
  onUninstall: () => void
}

export function SkillCard({ skill, busy, labels, onInstall, onUninstall }: Props) {
  const canUninstall = skill.installed
    && skill.sourceKind !== 'builtin'
    && skill.sourceKind !== 'project'
  const canInstall = !skill.installed && skill.sourceKind === 'remote'

  return (
    <article className="flex h-full min-h-[168px] flex-col rounded-xl border border-border/40 bg-card/30 p-3.5 transition-colors hover:border-border/60 hover:bg-card/50">
      <div className="flex items-start gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Sparkles size={14} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="truncate text-[13px] font-medium leading-snug text-foreground">{skill.label}</h3>
            <span className="shrink-0 rounded-md bg-secondary/80 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
              {SOURCE_KIND_LABEL[skill.sourceKind]}
            </span>
          </div>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/80">{skill.id}</p>
        </div>
      </div>

      <p className="mt-3 line-clamp-3 flex-1 text-[11px] leading-relaxed text-muted-foreground">
        {skill.description || '—'}
      </p>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/30 pt-3">
        <span className="truncate text-[10px] text-muted-foreground/70">
          {skill.version ? `v${skill.version}` : skill.sourceId}
        </span>
        {canInstall ? (
          <Button size="sm" variant="primary" isDisabled={busy} onPress={onInstall}>
            {labels.install}
          </Button>
        ) : canUninstall ? (
          <Button size="sm" variant="secondary" isDisabled={busy} onPress={onUninstall}>
            {labels.uninstall}
          </Button>
        ) : (
          <span className="text-[10px] text-muted-foreground">
            {skill.installed ? labels.installed : labels.available}
          </span>
        )}
      </div>
    </article>
  )
}
