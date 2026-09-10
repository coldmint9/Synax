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

// Minimal light/dark VS Code-ish theme using Shiki's CSS-variables theme,
// so colors follow the host palette without bundling a heavy theme object.
const theme = createCssVariablesTheme({
  name: 'synax-code',
  variablePrefix: '--synax-code-',
  variableDefaults: {
    '--synax-code-fg': '#d4d4d4',
    '--synax-code-bg': '#1e1e1e',
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
