import type { SignatureContent } from '../../../../lib/contracts/wiki'
import { useShellStore } from '../../../state/shellStore'
import { useHighlightedCode } from './useHighlightedCode'

export default function SignatureBlock({ content }: { content: SignatureContent }) {
  const theme = useShellStore(s => s.preferences.theme)
  const code = content.tokens.map(t => t.value).join('')
  const html = useHighlightedCode(code, content.language)

  return (
    <div className="bg-[var(--wiki-raised)] border border-[var(--wiki-border)] rounded-[var(--wiki-radius)] p-3.5 my-4 overflow-x-auto">
      {html ? (
        <div
          className="wiki-code-block font-[family-name:var(--wiki-mono)] text-[12.5px] leading-[1.7] [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:!m-0 [&_code]:!bg-transparent"
          data-theme={theme}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <code className="font-[family-name:var(--wiki-mono)] text-[12.5px] leading-[1.7] text-[var(--wiki-text)]">
          {code}
        </code>
      )}
      <div className="mt-2 pt-2 border-t border-[var(--wiki-border-subtle)] flex items-center gap-1.5 text-[11px] text-[var(--wiki-text-muted)] font-[family-name:var(--wiki-mono)]">
        <span>📄</span>
        <span className="text-[var(--wiki-accent-dim)]">
          {content.source.file}{content.source.line ? `:${content.source.line}` : ''}
        </span>
      </div>
    </div>
  )
}
