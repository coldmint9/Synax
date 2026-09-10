import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileDiff, RefreshCw } from 'lucide-react'
import { parsePatch } from 'diff'
import { agentRuntimeApi } from '../../../lib/api/agentRuntime'
import { highlightLines } from './codeHighlight'

type DiffLineType = 'file' | 'hunk' | 'add' | 'del' | 'ctx' | 'meta' | 'raw'

interface DiffLine {
  key: string
  type: DiffLineType
  oldLine: string
  newLine: string
  text: string
}

interface ParsedDiff {
  lines: DiffLine[]
  /** Rows per hunk: each side is highlighted as one contiguous block so
   *  multi-line constructs still tokenize the way an editor would. */
  hunks: DiffLine[][]
}

function marker(type: DiffLineType): string {
  if (type === 'add') return '+'
  if (type === 'del') return '-'
  return ''
}

/**
 * `a/src/x.ts` / `b/src/x.ts` both name the same file, so both collapse to the
 * bare path. `/dev/null` means "no file on this side" and becomes an empty
 * string, which callers read as a whole-file add or delete.
 */
function cleanPath(name: string): string {
  if (!name || name === '/dev/null') return ''
  return name.replace(/^[ab]\//, '')
}

function renderLines(raw: string): ParsedDiff {
  const lines: DiffLine[] = []
  const hunks: DiffLine[][] = []
  let seq = 0
  const nextKey = () => `diff-${seq++}`

  if (!raw.trim()) return { lines, hunks }

  try {
    const files = parsePatch(raw)
    for (const file of files) {
      const oldName = cleanPath(file.oldFileName ?? '')
      const newName = cleanPath(file.newFileName ?? '')
      // The panel header already names the file, and an untracked/deleted file
      // is obvious from its all-green/all-red rows, so the band is only worth a
      // row for a rename — where the two paths are the actual news.
      const renamed = Boolean(oldName && newName) && oldName !== newName
      if (renamed) {
        lines.push({
          key: nextKey(),
          type: 'file',
          oldLine: '',
          newLine: '',
          text: `${oldName} → ${newName}`,
        })
      }

      for (const hunk of file.hunks) {
        const group: DiffLine[] = []
        const push = (line: DiffLine) => {
          lines.push(line)
          group.push(line)
        }
        push({
          key: nextKey(),
          type: 'hunk',
          oldLine: '',
          newLine: '',
          text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        })

        let oldLine = hunk.oldStart
        let newLine = hunk.newStart
        for (const rawLine of hunk.lines) {
          const prefix = rawLine.slice(0, 1)
          const text = rawLine.slice(1)
          if (prefix === '+') {
            push({ key: nextKey(), type: 'add', oldLine: '', newLine: String(newLine), text })
            newLine += 1
          } else if (prefix === '-') {
            push({ key: nextKey(), type: 'del', oldLine: String(oldLine), newLine: '', text })
            oldLine += 1
          } else if (prefix === ' ') {
            push({ key: nextKey(), type: 'ctx', oldLine: String(oldLine), newLine: String(newLine), text })
            oldLine += 1
            newLine += 1
          } else {
            push({ key: nextKey(), type: 'meta', oldLine: '', newLine: '', text: rawLine })
          }
        }

        // A hunk always carries at least one side's lines; skip the empty ones.
        if (group.length > 1) hunks.push(group)
      }
    }
  } catch {
    lines.push({ key: nextKey(), type: 'raw', oldLine: '', newLine: '', text: raw })
  }

  // `parsePatch` happily returns an empty file list for text that is not a
  // patch at all (mode-only changes land here too). Show the payload verbatim
  // rather than pretending the file has no differences.
  const hasCodeRows = lines.some(line => line.type === 'add' || line.type === 'del' || line.type === 'ctx')
  if (!hasCodeRows && raw.trim()) {
    return { lines: [{ key: nextKey(), type: 'raw', oldLine: '', newLine: '', text: raw }], hunks: [] }
  }

  return { lines, hunks }
}

/**
 * Highlight both sides of every hunk.
 *
 * Deleted and context rows come from the old file, added and context rows from
 * the new one, so each side is highlighted as its own contiguous block and the
 * resulting line fragments are mapped back onto the rows by key.
 */
async function highlightHunks(hunks: DiffLine[][], path: string): Promise<Record<string, string>> {
  const html: Record<string, string> = {}
  await Promise.all(hunks.map(async group => {
    const oldRows = group.filter(line => line.type === 'del' || line.type === 'ctx')
    const newRows = group.filter(line => line.type === 'add' || line.type === 'ctx')
    const [oldHtml, newHtml] = await Promise.all([
      oldRows.length ? highlightLines(oldRows.map(line => line.text).join('\n'), path) : [],
      newRows.length ? highlightLines(newRows.map(line => line.text).join('\n'), path) : [],
    ])
    // Context rows exist on both sides; the new side wins, the text is identical.
    oldRows.forEach((row, index) => {
      if (oldHtml[index] !== undefined) html[row.key] = oldHtml[index]
    })
    newRows.forEach((row, index) => {
      if (newHtml[index] !== undefined) html[row.key] = newHtml[index]
    })
  }))
  return html
}

/** One table row: a full-width band for file/hunk/meta rows, a line row otherwise. */
function DiffRow({ line, html }: { line: DiffLine; html?: string }) {
  if (line.type === 'file' || line.type === 'hunk' || line.type === 'meta') {
    return (
      <tr className={`diff-row diff-row--${line.type}`}>
        <td className={`diff-band diff-band--${line.type}`} colSpan={4}>{line.text}</td>
      </tr>
    )
  }
  if (line.type === 'raw') {
    return (
      <tr className="diff-row diff-row--raw">
        <td className="diff-raw" colSpan={4}>{line.text}</td>
      </tr>
    )
  }
  return (
    <tr className={`diff-row diff-row--${line.type}`}>
      <td className="diff-num diff-num--old">{line.oldLine}</td>
      <td className="diff-num diff-num--new">{line.newLine}</td>
      <td className="diff-marker">{marker(line.type)}</td>
      <td className="diff-text">
        {html !== undefined
          ? <span dangerouslySetInnerHTML={{ __html: html }} />
          : line.text}
      </td>
    </tr>
  )
}

export const DiffViewer = memo(function DiffViewer({ sessionId, path }: { sessionId: string; path: string }) {
  const [parsed, setParsed] = useState<ParsedDiff>({ lines: [], hunks: [] })
  const [lineHtml, setLineHtml] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Guards against a slow response for a previous file overwriting the current one.
  const requestRef = useRef(0)

  const load = useCallback(async () => {
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    setLoading(true)
    setError(null)
    try {
      const result = await agentRuntimeApi.getSessionEnvironmentFile(sessionId, path, 'diff')
      if (requestRef.current !== requestId) return
      const next = renderLines(result.content ?? '')
      setParsed(next)
      setLineHtml({})
      // Paint the rows first and let syntax colors land right after, so a large
      // diff never sits behind a blank highlighting pass.
      setLoading(false)
      const html = await highlightHunks(next.hunks, path)
      if (requestRef.current !== requestId) return
      setLineHtml(html)
    } catch (err) {
      if (requestRef.current !== requestId) return
      setError(err instanceof Error ? err.message : '读取 diff 失败')
      setLoading(false)
    }
  }, [path, sessionId])

  useEffect(() => {
    void load()
    return () => { requestRef.current += 1 }
  }, [load])

  const stats = useMemo(() => {
    let added = 0
    let removed = 0
    for (const line of parsed.lines) {
      if (line.type === 'add') added += 1
      else if (line.type === 'del') removed += 1
    }
    return { added, removed }
  }, [parsed])

  return (
    <div className="diff-viewer flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/30 bg-secondary/20 px-2.5 py-1.5">
        <FileDiff size={12} className="text-primary" />
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground" title={path}>{path}</span>
        {stats.added > 0 || stats.removed > 0 ? (
          <span className="diff-stats font-mono text-[10px]">
            <span className="diff-stat diff-stat--add">+{stats.added}</span>
            <span className="diff-stat diff-stat--del">-{stats.removed}</span>
          </span>
        ) : null}
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
      <div className="diff-viewer-body session-workspace-scroll min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="file-viewer-status">读取中…</div>
        ) : error ? (
          <div className="file-viewer-status file-viewer-status--error">{error}</div>
        ) : parsed.lines.length === 0 ? (
          <div className="file-viewer-status flex items-center justify-center gap-1.5">
            <FileDiff size={12} />
            该文件与 HEAD 相比没有差异
          </div>
        ) : (
          <table className="diff-table">
            <tbody>
              {parsed.lines.map(line => (
                <DiffRow key={line.key} line={line} html={lineHtml[line.key]} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
})
