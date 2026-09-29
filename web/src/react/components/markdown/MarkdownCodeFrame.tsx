import type { ReactNode } from "react";

export function MarkdownCodeFrame({
  language,
  children,
}: {
  language?: string;
  children: ReactNode;
}) {
  const label = !language || /^(text|plaintext|txt)$/i.test(language)
    ? "纯文本"
    : language;

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-block__header">{label}</div>
      {children}
    </div>
  );
}
