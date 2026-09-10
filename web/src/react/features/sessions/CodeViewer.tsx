import { memo, useEffect, useMemo, useState } from 'react'
import { FileCode2, RefreshCw } from 'lucide-react'
import { agentRuntimeApi } from '../../../lib/api/agentRuntime'
import { highlightCode, languageForPath } from './codeHighlight'

function LineNumbers({ count }: { count: number }) {
  const lines = useMemo(() => Array.from({ length: count }, (_, i) => i + 1), [count])
  return (
    <div aria-hidden className="code-viewer-line-numbers select-none text-right font-mono text-[11px] leading-[1.5] text-muted-foreground/50">
      {lines.map(line => <div key={line}>{line}</div>)}
    </div>
  )
}

export const CodeViewer = memo(function CodeViewer({ sessionId, path }: { sessionId: string; path: string }) {
  const [content, setContent] = useState('')
  const [html, setHtml] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await agentRuntimeApi.getSessionEnvironmentFile(sessionId, path, 'input')
      const text = result.content ?? ''
      setContent(text)
      setHtml(await highlightCode(text, path))
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取文件失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await agentRuntimeApi.getSessionEnvironmentFile(sessionId, path, 'input').catch(() => null)
      if (cancelled || !result) return
      setContent(result.content ?? '')
      setHtml(await highlightCode(result.content ?? '', path))
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [path, sessionId])

  const lineCount = useMemo(() => (content ? content.split('\n').length : 0), [content])
  const language = languageForPath(path)

  return (
    <div className="code-viewer flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/30 bg-secondary/20 px-2.5 py-1.5">
        <FileCode2 size={12} className="text-primary" />
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground" title={path}>{path}</span>
        <span className="rounded bg-secondary/60 px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground">{language}</span>
        <button
          type="button"
          className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
          onClick={() => void load()}
          aria-label="刷新文件"
          title="刷新文件"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-[var(--cx-gray-800)]">
        {loading ? (
          <div className="p-3 text-[10px] text-muted-foreground">读取中…</div>
        ) : error ? (
          <div className="p-3 text-[10px] text-destructive">{error}</div>
        ) : (
          <div className="flex min-w-max">
            <div className="sticky left-0 z-10 border-r border-white/10 bg-[var(--cx-gray-800)] px-2 py-2">
              <LineNumbers count={lineCount} />
            </div>
            <div
              className="code-viewer-content min-w-max px-2 py-2 font-mono text-[11px] leading-[1.5]"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        )}
      </div>
    </div>
  )
})
