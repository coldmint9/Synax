import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, ScrollText } from 'lucide-react'
import { useLocale } from '../../../hooks/useLocale'
import { useDebugConsole } from '../debug-console/debugConsoleStore'

export function SessionSystemPromptPanel() {
  const { t } = useLocale()
  const session = useDebugConsole(s => {
    const id = s.selectedSessionId
    return id ? s.sessions.find(item => item.id === id) : undefined
  })
  const [open, setOpen] = useState(false)
  const prompt = session?.prompt?.trim()

  useEffect(() => {
    setOpen(false)
  }, [session?.id])

  if (!prompt) return null

  return (
    <div className="border-b border-border/40 px-2 py-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left transition-colors ${
          open ? 'bg-accent/10 text-foreground' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground/85'
        }`}
      >
        <ScrollText size={11} className="shrink-0 opacity-75" />
        <span className="min-w-0 flex-1 truncate text-[10px] font-medium">
          {t('sessionSystemPrompt')}
        </span>
        {open
          ? <ChevronUp size={11} className="shrink-0 opacity-60" />
          : <ChevronDown size={11} className="shrink-0 opacity-60" />}
      </button>
      {open && (
        <div className="mt-1.5 max-h-56 overflow-y-auto rounded-md border border-border/40 bg-secondary/20 px-2 py-2 text-[10px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
          {prompt}
        </div>
      )}
    </div>
  )
}
