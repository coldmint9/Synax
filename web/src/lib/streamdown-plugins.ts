import type { CodeHighlighterPlugin, DiagramPlugin, PluginConfig } from 'streamdown'
import type { BundledLanguage, BundledTheme } from 'shiki'
import mermaid from 'mermaid'

mermaid.initialize({ startOnLoad: false, theme: 'dark' })

const DARK_THEME: BundledTheme = 'github-dark'
const LIGHT_THEME: BundledTheme = 'github-light'

let highlighterPromise: Promise<any> | null = null

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(({ createHighlighter }) =>
      createHighlighter({ themes: [DARK_THEME, LIGHT_THEME], langs: [] })
    )
  }
  return highlighterPromise
}

const shikiPlugin: CodeHighlighterPlugin = {
  name: 'shiki',
  type: 'code-highlighter',
  getThemes: () => [DARK_THEME, LIGHT_THEME],
  getSupportedLanguages: () => [] as BundledLanguage[],
  supportsLanguage: () => true,
  highlight(options, callback) {
    getHighlighter().then(async (highlighter) => {
      const langs = highlighter.getLoadedLanguages()
      if (!langs.includes(options.language)) {
        try {
          await highlighter.loadLanguage(options.language)
        } catch {
          callback?.({ tokens: [[{ content: options.code }]] })
          return
        }
      }
      const result = highlighter.codeToTokens(options.code, {
        lang: options.language,
        themes: { dark: DARK_THEME, light: LIGHT_THEME },
      })
      const tokens = result.tokens.map((line: any[]) =>
        line.map((t: any) => ({
          content: t.content,
          color: t.htmlStyle?.['--shiki-dark'] ?? t.htmlStyle?.color,
          htmlStyle: t.htmlStyle,
        }))
      )
      callback?.({ tokens, bg: result.bg, fg: result.fg })
    })
    return null
  },
}

const mermaidPlugin: DiagramPlugin = {
  name: 'mermaid',
  type: 'diagram',
  language: 'mermaid',
  getMermaid: () => mermaid,
}

export const streamdownPlugins: PluginConfig = {
  code: shikiPlugin,
  mermaid: mermaidPlugin,
}
