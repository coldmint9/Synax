import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { MarkdownImage } from "./MarkdownImage";
import { renderMarkdownCodeBlock } from "./MarkdownCodeBlock";

export const sharedMarkdownComponents: Components = {
  pre({ children }) {
    return <>{children}</>;
  },
  code({ className, children, ...props }) {
    const match = /language-([^\s]+)/.exec(className ?? "");
    const language = match?.[1];
    const code = String(children).replace(/\n$/, "");
    const block = renderMarkdownCodeBlock(code, language);
    if (block) return block;

    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  img({ src, alt, title }) {
    return (
      <MarkdownImage src={src} alt={alt ?? ""} title={title ?? undefined} />
    );
  },
};

interface Props {
  content: string;
  className?: string;
  components?: Components;
  remarkPlugins?: PluggableList;
  rehypePlugins?: PluggableList;
  conversationClass?: boolean;
}

export function MarkdownRenderer({
  content,
  className = "feed-prose",
  components,
  remarkPlugins,
  rehypePlugins,
  conversationClass = true,
}: Props) {
  const rootClassName = conversationClass
    ? `agent-conversation-copy ${className}`
    : className;

  return (
    <div className={rootClassName}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, ...(remarkPlugins ?? [])]}
        rehypePlugins={[rehypeKatex, ...(rehypePlugins ?? [])]}
        components={{ ...sharedMarkdownComponents, ...components }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
