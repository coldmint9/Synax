import type { TableContent } from '../../../../lib/contracts/wiki'

function CellContent({ value }: { value: string | { type: 'code'; value: string } }) {
  if (typeof value === 'string') return <>{value}</>
  return (
    <code className="font-[family-name:var(--wiki-mono)] text-[11.5px] text-[var(--wiki-accent)]">
      {value.value}
    </code>
  )
}

export default function TableBlock({ content }: { content: TableContent }) {
  return (
    <div className="my-4 border border-[var(--wiki-border)] rounded-[var(--wiki-radius)] overflow-hidden">
      <table className="w-full border-collapse text-[13px]">
        <thead className="bg-[var(--wiki-raised)]">
          <tr>
            {content.headers.map(h => (
              <th
                key={h.key}
                className="text-left font-semibold text-[11px] uppercase tracking-[0.04em] text-[var(--wiki-text-muted)] px-3.5 py-2.5 border-b border-[var(--wiki-border)]"
              >
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {content.rows.map((row, ri) => (
            <tr key={ri} className="last:[&>td]:border-b-0 hover:bg-[var(--wiki-accent-bg)]">
              {content.headers.map(h => (
                <td
                  key={h.key}
                  className="px-3.5 py-2.5 border-b border-[var(--wiki-border-subtle)] text-[var(--wiki-text-secondary)] align-top"
                >
                  <CellContent value={row[h.key] ?? ''} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
