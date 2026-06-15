import type { BundledLanguage, BundledTheme, HighlighterGeneric } from 'shiki'

export const WIKI_SHIKI_LIGHT: BundledTheme = 'github-light'
export const WIKI_SHIKI_DARK: BundledTheme = 'github-dark'

let highlighterPromise: Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> | null = null

function getHighlighterPromise() {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(({ createHighlighter }) =>
      createHighlighter({
        themes: [WIKI_SHIKI_LIGHT, WIKI_SHIKI_DARK],
        langs: [],
      }),
    )
  }
  return highlighterPromise
}

export async function highlightWikiCode(code: string, language: string): Promise<string> {
  const highlighter = await getHighlighterPromise()
  const lang = language as BundledLanguage
  const loaded = highlighter.getLoadedLanguages()
  if (!loaded.includes(lang)) {
    try {
      await highlighter.loadLanguage(lang)
    } catch {
      return ''
    }
  }

  return highlighter.codeToHtml(code, {
    lang,
    themes: {
      light: WIKI_SHIKI_LIGHT,
      dark: WIKI_SHIKI_DARK,
    },
    defaultColor: false,
  })
}
