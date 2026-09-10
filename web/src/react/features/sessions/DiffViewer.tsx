import { memo, useEffect, useMemo, useState } from 'react'
import { FileDiff, RefreshCw } from 'lucide-react'
import { parsePatch } from 'diff'
import { agentRuntimeApi } from '../../../lib/api/agentRuntime'

interface DiffLine {
  key: string
  type: 'add' | 'del' | 'ctx' | 'meta'
  oldLine: string
  newLine: string
  text: string
}

function renderLines(raw: string): DiffLine[] {
  const out: DiffLine[] = []
  try {
    const files = parsePatch(raw)
    for (const file of files) {
      out.push({
        key: `meta-${file.index}`,
        type: 'meta',
        oldLine: '',
        newLine: '',
        text: `${file.oldFileName ?? ''} → ${file.newFileName ?? ''}`.trim() || raw,
      })
      for (const hunk of file.hunks) {
        let oldLine = hunk.oldStart
        let newLine = hunk.newStart
        for (const line of hunk.lines) {
          const prefix = line.slice(0, 1)
          const text = line.slice(1)
          if (prefix === '+') {
            out.push({ key: `${file.index}-${hunk.oldStart}-${newLine}`, type: 'add', oldLine: '', newLine: String(newLine), text })
            newLine += 1
          } else if (prefix === '-') {
            out.push({ key: `${file.index}-${oldLine}-${hunk.newStart}`, type: 'del', oldLine: String(oldLine), newLine: '', text })
            oldLine += 1
          } else if (prefix === ' ') {
            out.push({ key: `${file.index}-${oldLine}-${newLine}`, type: 'ctx', oldLine: String(oldLine), newLine: String(newLine), text })
            oldLine += 1
            newLine += 1
          } else {
            out.push({ key: `${file.index}-meta-${text}`, type: 'meta', oldLine: '', newLine: '', text: line })
          }
        }
      }
    }
  } catch {
    out.push({ key: 'raw', type: 'meta', oldLine: '', newLine: '', text: raw })
  }
  return out
}

function lineClass(type: DiffLine['type']): string {
  switch (type) {
    case 'add': return 'diff-line diff-line--add'
    case 'del': return 'diff-line diff-line--del'
    case 'ctx': return 'diff-line diff-line--ctx'
    default: return 'diff-line diff-line--meta'
  }
}

export const DiffViewer = memo(function DiffViewer({ sessionId, path }: { sessionId: string; path: string }) {
  const [raw, setRaw] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await agentRuntimeApi.getSessionEnvironmentFile(sessionId, path, 'diff')
      setRaw(result.content ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取 diff 失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, sessionId])

  const lines = useMemo(() => renderLines(raw), [raw])

  return (
    <div className="diff-viewer flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/30 bg-secondary/20 px-2.5 py-1.5">
        <FileDiff size={12} className="text-primary" />
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground" title={path}>{path}</span>
        <button
          type="button"
          className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
          onClick={() => void load()}
          aria-label="刷新 diff"
          title="刷新 diff"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-[#1e1e1e]">
        {loading ? (
          <div className="p-3 text-[10px] text-muted-foreground">读取中…</div>
        ) : error ? (
          <div className="p-3 text-[10px] text-destructive">{error}</div>
        ) : (
          <table className="w-full border-collapse font-mono text-[11px] leading-[1.5]">
            <tbody>
              {lines.map(line => (
                <tr key={line.key} className={lineClass(line.type)}>
                  <td className="diff-line-num sticky left-0 w-10 select-none border-r border-white/5 px-1 text-right text-white/35">{line.oldLine}</td>
                  <td className="diff-line-num w-10 select-none border-r border-white/5 px-1 text-right text-white/35">{line.newLine}</td>
                  <td className="whitespace-pre-wrap break-words px-2">
                    <span className="mr-2 select-none opacity-60">
                      {line.type === 'add' ? '+' : line.type === 'del' ? '-' : line.type === 'ctx' ? ' ' : ''}
                    </span>
                    {line.text}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
})
