import type { ReactElement } from "react";
import { MermaidBlock } from "../../features/wiki/MermaidBlock";
import { ShikiCodeBlock } from "../../features/wiki/ShikiCodeBlock";

const TREE_LANGUAGES = new Set([
  "tree",
  "ascii",
  "ascii-tree",
  "directory-tree",
]);

export interface MarkdownCodeBlockOptions {
  renderTree?: (code: string) => ReactElement;
  renderPlain?: (code: string) => ReactElement;
  isTree?: (code: string) => boolean;
}

/** Shared code-fence renderer used by Wiki and conversation Markdown. */
export function renderMarkdownCodeBlock(
  code: string,
  language: string | undefined,
  options: MarkdownCodeBlockOptions = {},
): ReactElement | null {
  const normalized = language?.toLowerCase();
  if (normalized === "mermaid") return <MermaidBlock code={code} />;

  if (
    normalized &&
    !TREE_LANGUAGES.has(normalized) &&
    normalized !== "text" &&
    normalized !== "plaintext"
  ) {
    return <ShikiCodeBlock code={code} language={normalized} />;
  }

  if (
    (normalized && TREE_LANGUAGES.has(normalized)) ||
    options.isTree?.(code)
  ) {
    return (
      options.renderTree?.(code) ?? (
        <pre>
          <code>{code}</code>
        </pre>
      )
    );
  }

  if (
    normalized === "text" ||
    normalized === "plaintext" ||
    code.includes("\n")
  ) {
    return (
      options.renderPlain?.(code) ?? (
        <pre>
          <code>{code}</code>
        </pre>
      )
    );
  }

  return null;
}
