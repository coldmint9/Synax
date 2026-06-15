/** Multiline code without a language fence — preserve formatting. */
export function WikiPlainCodeBlock({ code }: { code: string }) {
  return (
    <div className="wiki-tree-block">
      <pre className="wiki-tree-block__pre">
        <code>{code.replace(/\n$/, '')}</code>
      </pre>
    </div>
  )
}
