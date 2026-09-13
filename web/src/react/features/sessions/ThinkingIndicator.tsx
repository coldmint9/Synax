export function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-1.5 px-1 py-2">
      <span className="flex items-center gap-1" aria-hidden>
        <span className="inline-block h-1 w-1 rounded-full bg-muted-foreground/40 animate-thinking-bounce" />
        <span className="inline-block h-1 w-1 rounded-full bg-muted-foreground/40 animate-thinking-bounce" style={{ animationDelay: '200ms' }} />
        <span className="inline-block h-1 w-1 rounded-full bg-muted-foreground/40 animate-thinking-bounce" style={{ animationDelay: '400ms' }} />
      </span>
    </div>
  )
}
