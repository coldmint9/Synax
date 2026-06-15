import { splitTreeLineComment } from './wikiTreeDetect'

export function WikiTreeBlock({ code }: { code: string }) {
  const lines = code.replace(/\n$/, '').split(/\r?\n/)

  return (
    <div className="wiki-tree-block" role="figure" aria-label="Directory tree">
      <pre className="wiki-tree-block__pre">
        <code>
          {lines.map((line, index) => {
            const { structure, comment } = splitTreeLineComment(line)
            return (
              <span key={index} className="wiki-tree-block__line">
                <span className="wiki-tree-block__structure">{structure}</span>
                {comment && (
                  <span className="wiki-tree-block__comment">{comment}</span>
                )}
              </span>
            )
          })}
        </code>
      </pre>
    </div>
  )
}
