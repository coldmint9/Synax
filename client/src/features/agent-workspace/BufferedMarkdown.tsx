import { useEffect, useState } from "react";
import { SessionMarkdown } from "./SessionMarkdown";
import { MarkdownCodeFrame } from "../../shared/ui/markdown/MarkdownCodeFrame";
import { useStreamingText } from "./useStreamingText";

function splitUnclosedFence(content: string): {
  stable: string;
  pending: string;
} {
  const fence = /^\s*(`{3,}|~{3,})[^\n]*$/gm;
  let openStart = -1;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = fence.exec(content))) {
    if (count % 2 === 0) openStart = match.index;
    count += 1;
  }

  return count % 2 === 1 && openStart >= 0
    ? { stable: content.slice(0, openStart), pending: content.slice(openStart) }
    : { stable: content, pending: "" };
}

/**
 * The trailing line that has no newline yet. It stays visible as plain text
 * while streaming so a partial paragraph is never hidden; once the newline
 * lands the line joins the stable Markdown above it.
 */
function splitIncompleteLine(content: string): {
  stable: string;
  pending: string;
} {
  const lastNewline = content.lastIndexOf("\n");
  if (lastNewline < 0) return { stable: "", pending: content };
  return {
    stable: content.slice(0, lastNewline + 1),
    pending: content.slice(lastNewline + 1),
  };
}

export function BufferedMarkdown({
  content,
  isStreaming,
  className,
  startDelayMs = 0,
}: {
  content: string;
  isStreaming: boolean;
  className?: string;
  startDelayMs?: number;
}) {
  const [released, setReleased] = useState(startDelayMs === 0);

  useEffect(() => {
    if (startDelayMs <= 0) {
      setReleased(true);
      return;
    }
    setReleased(false);
    const timer = window.setTimeout(() => setReleased(true), startDelayMs);
    return () => window.clearTimeout(timer);
  }, [startDelayMs]);

  const visible = useStreamingText(
    released ? content : "",
    isStreaming && released,
  );
  const fenceSplit = isStreaming ? splitUnclosedFence(visible) : null;
  const fencePending = Boolean(fenceSplit && fenceSplit.pending);
  const { stable, pending } = fencePending
    ? fenceSplit!
    : isStreaming
      ? splitIncompleteLine(visible)
      : { stable: visible, pending: "" };
  const pendingFence = fencePending
    ? /^\s*(?:`{3,}|~{3,})([^\n]*)\n?/.exec(pending)
    : null;

  return (
    <>
      {stable && <SessionMarkdown content={stable} className={className} />}
      {pending && fencePending && (
        <MarkdownCodeFrame language={pendingFence?.[1].trim().split(/\s+/)[0]?.toLowerCase()}>
        <pre className="markdown-stream-pending agent-conversation-copy">
          <code>{pending.slice(pendingFence?.[0].length ?? 0)}</code>
        </pre>
        </MarkdownCodeFrame>
      )}
      {pending && !fencePending && (
        <span className="markdown-stream-tail agent-conversation-copy">
          {pending}
        </span>
      )}
    </>
  );
}
