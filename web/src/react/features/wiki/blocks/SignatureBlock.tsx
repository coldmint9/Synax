import { useState, useEffect } from 'react'
import type { SignatureContent } from '../../../../lib/contracts/wiki'
import { useShellStore } from '../../../state/shellStore'

interface ShikiToken {
  content: string
  htmlStyle?: Record<string, string>
}

let highlighterPromise: Promise<any> | null = null

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(({ createHighlighter }) =>
      createHighlighter({ themes: ['github-dark', 'github-light'], langs: [] })
    )
  }
  return highlighterPromise
}

function useHighlightedTokens(code: string, language: string, theme: 'light' | 'dark') {
  const [tokens, setTokens] = useState<ShikiToken[][] | null>(null)

  useEffect(() => {
    let cancelled = false
    getHighlighter().then(async (highlighter) => {
      const langs = highlighter.getLoadedLanguages()
      if (!langs.includes(language)) {
        try {
          await highlighter.loadLanguage(language)
        } catch {
          if (!cancelled) setTokens(null)
          return
        }
      }
      const shikiTheme = theme === 'dark' ? 'github-dark' : 'github-light'
      const result = highlighter.codeToTokens(code, {
        lang: language,
        theme: shikiTheme,
      })
      if (!cancelled) setTokens(result.tokens)
    })
    return () => { cancelled = true }
  }, [code, language, theme])

  return tokens
}

export default function SignatureBlock({ content }: { content: SignatureContent }) {
  const theme = useShellStore(s => s.preferences.theme)
  const code = content.tokens.map(t => t.value).join('')
  const highlighted = useHighlightedTokens(code, content.language, theme)

  return (
    <div className="bg-[var(--wiki-raised)] border border-[var(--wiki-border)] rounded-[var(--wiki-radius)] p-3.5 my-4 overflow-x-auto">
      <code className="font-[family-name:var(--wiki-mono)] text-[12.5px] leading-[1.7] block whitespace-pre">
        {highlighted ? (
          highlighted.map((line, li) => (
            <span key={li}>
              {line.map((token, ti) => (
                <span key={ti} style={{ color: token.htmlStyle?.color }}>
                  {token.content}
                </span>
              ))}
              {li < highlighted.length - 1 && '\n'}
            </span>
          ))
        ) : (
          <span className="text-[var(--wiki-text)]">{code}</span>
        )}
      </code>
      <div className="mt-2 pt-2 border-t border-[var(--wiki-border-subtle)] flex items-center gap-1.5 text-[11px] text-[var(--wiki-text-muted)] font-[family-name:var(--wiki-mono)]">
        <span>📄</span>
        <a className="text-[var(--wiki-accent-dim)] no-underline hover:underline">
          {content.source.file}{content.source.line ? `:${content.source.line}` : ''}
        </a>
      </div>
    </div>
  )
}
