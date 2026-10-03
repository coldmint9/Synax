import { useRef, type ReactNode } from "react";
import "./highlightedCodeEditor.css";

/** A native text editor over a non-interactive Shiki layer. The textarea is
 * the sole scroll owner, preserving selection, undo and IME composition. */
export function HighlightedCodeEditor({
  path,
  content,
  html,
  onChange,
  gutter,
}: {
  path: string;
  content: string;
  html?: string;
  onChange: (content: string) => void;
  gutter: ReactNode;
}) {
  const paint = useRef<HTMLDivElement>(null);
  const numbers = useRef<HTMLDivElement>(null);
  return (
    <div className="highlighted-code-editor">
      <div
        className="code-viewer-gutter highlighted-code-editor-gutter"
        aria-hidden="true"
      >
        <div ref={numbers} className="highlighted-code-editor-numbers">
          {gutter}
        </div>
      </div>
      <div className="highlighted-code-editor-viewport">
        <div className="highlighted-code-editor-overlay" aria-hidden="true">
          <div ref={paint} className="highlighted-code-editor-paint">
            {html === undefined ? (
              <pre>{content || "\n"}</pre>
            ) : (
              <div dangerouslySetInnerHTML={{ __html: html }} />
            )}
          </div>
        </div>
        <textarea
          aria-label={`编辑文件 ${path}`}
          className="highlighted-code-editor-input session-workspace-scroll"
          value={content}
          wrap="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => onChange(event.target.value)}
          onScroll={(event) => {
            const { scrollTop, scrollLeft } = event.currentTarget;
            if (paint.current)
              paint.current.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
            if (numbers.current)
              numbers.current.style.transform = `translateY(${-scrollTop}px)`;
          }}
        />
      </div>
    </div>
  );
}
