import ReactMarkdown from "react-markdown";
import type { Components, UrlTransform } from "react-markdown";
import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { MarkdownImage } from "./MarkdownImage";
import { renderMarkdownPre } from "./MarkdownCodeBlock";

export const sharedMarkdownComponents: Components = {
  pre({ children }) {
    return renderMarkdownPre(children);
  },
  code({ className, children, node: _node, ...props }) {
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
  imageResolver?: (src: string) => string;
  urlTransform?: UrlTransform;
}

export function MarkdownRenderer({
  content,
  className = "feed-prose",
  components,
  remarkPlugins,
  rehypePlugins,
  conversationClass = true,
  imageResolver,
  urlTransform,
}: Props) {
  const rootClassName = conversationClass
    ? `agent-conversation-copy ${className}`
    : className;

  return (
    <div className={rootClassName}>
      <ReactMarkdown
        urlTransform={urlTransform}
        remarkPlugins={[remarkGfm, remarkMath, ...(remarkPlugins ?? [])]}
        rehypePlugins={[rehypeKatex, ...(rehypePlugins ?? [])]}
        components={{
          ...sharedMarkdownComponents,
          ...(imageResolver ? { img: ({ src, alt, title }) => <MarkdownImage src={imageResolver(src ?? "")} alt={alt ?? ""} title={title ?? undefined} /> } : {}),
          ...components,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
