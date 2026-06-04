import type { SignatureContent } from '../../../../lib/contracts/wiki'

const TOKEN_COLORS: Record<string, string> = {
  keyword: 'var(--wiki-purple)',
  type: 'var(--wiki-accent)',
  name: 'var(--wiki-green)',
  param: 'var(--wiki-orange)',
  punctuation: 'var(--wiki-text-muted)',
  comment: 'var(--wiki-text-muted)',
}

export default function SignatureBlock({ content }: { content: SignatureContent }) {
  return (
    <div className="bg-[var(--wiki-raised)] border border-[var(--wiki-border)] rounded-[var(--wiki-radius)] p-3.5 my-4 overflow-x-auto">
      <code className="font-[family-name:var(--wiki-mono)] text-[12.5px] leading-[1.7]">
        {content.tokens.map((token, i) => (
          <span
            key={i}
            style={{ color: TOKEN_COLORS[token.type] }}
            className={token.type === 'name' ? 'font-medium' : token.type === 'comment' ? 'italic' : ''}
          >
            {token.value}
          </span>
        ))}
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
