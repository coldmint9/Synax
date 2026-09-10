import { createHighlighterCore, createCssVariablesTheme, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript'
import { bundledLanguages } from 'shiki/langs'

let highlighter: HighlighterCore | null = null
let highlighterPromise: Promise<HighlighterCore> | null = null

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  vue: 'vue', json: 'json', md: 'markdown', css: 'css', scss: 'scss', less: 'less',
  html: 'html', xml: 'xml', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  py: 'python', java: 'java', go: 'go', rs: 'rust', rb: 'ruby', php: 'php',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', swift: 'swift', kt: 'kotlin',
  sh: 'shell', bash: 'shell', sql: 'sql', dockerfile: 'dockerfile', gitignore: 'gitignore',
}

export function languageForPath(path: string): string {
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const ext = dot >= 0 ? lower.slice(dot + 1) : ''
  if (lower.endsWith('dockerfile')) return 'dockerfile'
  return LANG_BY_EXT[ext] ?? 'text'
}

// Shiki's CSS-variables theme emits `var(--synax-code-*)` for every token, so
// the palette lives in one place (index.css: `:root` for light, `.dark` for
// dark) and highlighted HTML follows the app theme without re-tokenising.
//
// The defaults below are the dark palette, used only as a fallback when the
// stylesheet has not defined the variables yet. They must keep the exact key
// names shiki resolves (`foreground`, `background`, `token-*`) — a mismatch
// makes every token color an invalid `var()` and the code renders unstyled.
const theme = createCssVariablesTheme({
  name: 'synax-code',
  variablePrefix: '--synax-code-',
  variableDefaults: {
    foreground: '#e6edf3',
    background: '#181818',
    'token-comment': '#8b949e',
    'token-keyword': '#ff7b72',
    'token-string': '#a5d6ff',
    'token-string-expression': '#7ee787',
    'token-constant': '#79c0ff',
    'token-function': '#d2a8ff',
    'token-parameter': '#ffa657',
    'token-punctuation': '#c9d1d9',
    'token-link': '#58a6ff',
    'token-inserted': '#3fb950',
    'token-deleted': '#f85149',
    'token-changed': '#d29922',
  },
  fontStyle: true,
})

const WANTED_LANGS = [
  'typescript', 'tsx', 'javascript', 'jsx', 'vue', 'json', 'markdown', 'css', 'scss',
  'less', 'html', 'xml', 'yaml', 'toml', 'python', 'java', 'go', 'rust', 'ruby',
  'php', 'c', 'cpp', 'swift', 'kotlin', 'shell', 'sql', 'dockerfile', 'text',
]

async function loadLanguages(h: HighlighterCore): Promise<void> {
  const loaders = bundledLanguages as unknown as Record<string, () => Promise<unknown>>
  for (const lang of WANTED_LANGS) {
    const loader = loaders[lang]
    if (typeof loader === 'function') {
      await h.loadLanguage(loader as never)
    }
  }
}

export async function highlightCode(code: string, path: string): Promise<string> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const engine = createJavaScriptRegexEngine()
      const h = await createHighlighterCore({
        themes: [theme],
        langs: [],
        engine,
      })
      await loadLanguages(h)
      highlighter = h
      return h
    })()
  }
  const h = await highlighterPromise
  const lang = languageForPath(path)
  try {
    return h.codeToHtml(code, { lang, theme: 'synax-code' })
  } catch {
    return h.codeToHtml(code, { lang: 'text', theme: 'synax-code' })
  }
}

/** Inner HTML of a shiki `<pre><code>` result, i.e. the line spans only. */
function unwrapCodeLineHtml(html: string): string {
  const open = html.indexOf('<code>')
  const close = html.lastIndexOf('</code>')
  if (open < 0 || close < 0 || close < open) return ''
  return html.slice(open + '<code>'.length, close)
}

/**
 * Highlight `code` and return one HTML fragment per source line.
 *
 * Line-based layouts (diff rows) need per-row markup instead of a single
 * `<pre>`; shiki wraps every line in `<span class="line">` and never lets a
 * token cross a newline, so splitting on `\n` yields balanced fragments.
 */
export async function highlightLines(code: string, path: string): Promise<string[]> {
  if (!code) return []
  const html = unwrapCodeLineHtml(await highlightCode(code, path))
  return html.split('\n').map(line =>
    line.replace(/^<span class="line">/, '').replace(/<\/span>$/, ''),
  )
}
