import { useMemo } from "react";
import { renderDiagram } from "../../lib/mermaid-renderer";

export function MermaidBlock({ code }: { code: string }) {
  const result = useMemo(() => renderDiagram(code), [code]);

  if (!result) {
    return (
      <pre className="md-mermaid-fallback">
        <code>{code}</code>
      </pre>
    );
  }

  if ("error" in result) {
    return (
      <pre className="md-mermaid-error">
        <code>{result.error}</code>
      </pre>
    );
  }

  return (
    <div
      className="md-mermaid"
      dangerouslySetInnerHTML={{ __html: result.svg }}
    />
  );
}
