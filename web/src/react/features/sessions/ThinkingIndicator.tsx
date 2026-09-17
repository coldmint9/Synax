import { useLocale } from '../../../hooks/useLocale'

export function ThinkingIndicator() {
  const { t } = useLocale()
  return (
    <div
      role="status"
      aria-label={t('sessionActivityThinking')}
      className="flex items-center gap-1.5 px-1 py-2"
    >
      <span className="flex items-center gap-1" aria-hidden="true">
        <span data-thinking-dot className="inline-block h-1 w-1 rounded-full bg-muted-foreground/40 animate-thinking-bounce" />
        <span data-thinking-dot className="inline-block h-1 w-1 rounded-full bg-muted-foreground/40 animate-thinking-bounce" style={{ animationDelay: '200ms' }} />
        <span data-thinking-dot className="inline-block h-1 w-1 rounded-full bg-muted-foreground/40 animate-thinking-bounce" style={{ animationDelay: '400ms' }} />
      </span>
    </div>
  )
}
