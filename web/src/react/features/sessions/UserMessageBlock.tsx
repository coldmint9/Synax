interface Props {
  content: string
}

export function UserMessageBlock({ content }: Props) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[min(85%,42rem)] rounded-2xl border border-primary/15 bg-primary/[0.08] px-3.5 py-2.5 text-sm leading-relaxed text-foreground whitespace-pre-wrap shadow-sm">
        {content}
      </div>
    </div>
  )
}
