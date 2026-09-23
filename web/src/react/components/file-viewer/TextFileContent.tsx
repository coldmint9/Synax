import { HighlightedCodeEditor } from "../../features/agent-workspace/HighlightedCodeEditor";

export function LineNumbers({ count }: { count: number }) {
  return (
    <div
      aria-hidden
      className="code-viewer-line-numbers select-none text-right font-mono text-[11px] leading-[1.5]"
    >
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>{i + 1}</div>
      ))}
    </div>
  );
}

/** Presentation only: callers own loading, revisions, persistence and drafts. */
export function TextFileContent({
  path,
  content,
  html,
  onChange,
}: {
  path: string;
  content: string;
  html?: string;
  onChange?: (content: string) => void;
}) {
  const count = Math.max(1, content.split("\n").length);
  if (onChange)
    return (
      <HighlightedCodeEditor
        path={path}
        content={content}
        html={html}
        onChange={onChange}
        gutter={<LineNumbers count={count} />}
      />
    );
  return (
    <div className="flex min-w-max items-stretch">
      <div className="code-viewer-gutter sticky left-0 z-10 px-2 py-2">
        <LineNumbers count={count} />
      </div>
      <div className="code-viewer-content min-w-max px-3 py-2 font-mono text-[11px] leading-[1.5]">
        {html === undefined ? (
          <pre>{content}</pre>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
    </div>
  );
}
