interface Props {
  toolId: string
  summary: string
  running?: boolean
}

export function GoalToolRow({ toolId, summary, running }: Props) {
  return (
    <div className="flex items-baseline gap-2.5 py-0.5 text-xs leading-snug">
      <span className={`shrink-0 min-w-[6.25rem] font-mono text-[11px] ${running ? 'text-primary' : 'text-muted-foreground/55'}`}>
        {toolId}
      </span>
      <span className={`min-w-0 flex-1 truncate ${running ? 'text-foreground/75' : 'text-muted-foreground/55'}`}>
        {summary}
      </span>
    </div>
  )
}
