import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { MermaidBlock } from "../../features/wiki/MermaidBlock";
import { ShikiCodeBlock } from "../../features/wiki/ShikiCodeBlock";
import { MarkdownCodeFrame } from "./MarkdownCodeFrame";

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
  isBlock?: boolean;
}

export function renderMarkdownPre(
  children: ReactNode,
  options: MarkdownCodeBlockOptions = {},
) {
  const child = Children.toArray(children)[0];
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) {
    return <pre>{children}</pre>;
  }
  const language = /language-([^\s]+)/.exec(child.props.className ?? "")?.[1];
  const code = String(child.props.children ?? "").replace(/\n$/, "");
  return renderMarkdownCodeBlock(code, language, { ...options, isBlock: true });
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
    return (
      <MarkdownCodeFrame language={normalized}>
        <ShikiCodeBlock code={code} language={normalized} />
      </MarkdownCodeFrame>
    );
  }

  if (
    (normalized && TREE_LANGUAGES.has(normalized)) ||
    options.isTree?.(code)
  ) {
    return (
      <MarkdownCodeFrame language={normalized ?? "tree"}>
        {options.renderTree?.(code) ?? (
          <pre>
            <code>{code}</code>
          </pre>
        )}
      </MarkdownCodeFrame>
    );
  }

  if (
    normalized === "text" ||
    normalized === "plaintext" ||
    code.includes("\n") || options.isBlock
  ) {
    return (
      <MarkdownCodeFrame language={normalized}>
        {options.renderPlain?.(code) ?? (
          <pre>
            <code>{code}</code>
          </pre>
        )}
      </MarkdownCodeFrame>
    );
  }

  return null;
}
