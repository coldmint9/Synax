import { useEffect, useRef, useState } from "react";
import { SessionMarkdown } from "./SessionMarkdown";

const LINE_TICK_MS = 32;

function useLineBufferedText(text: string, isStreaming: boolean): string {
  const targetRef = useRef(text);
  const visibleRef = useRef(isStreaming ? "" : text);
  const [visible, setVisible] = useState(visibleRef.current);

  useEffect(() => {
    targetRef.current = text;
    if (!isStreaming) {
      visibleRef.current = text;
      setVisible(text);
      return;
    }

    // A restarted live block should not retain text from the previous block.
    if (!text.startsWith(visibleRef.current)) {
      visibleRef.current = "";
      setVisible("");
    }
  }, [text, isStreaming]);

  useEffect(() => {
    if (!isStreaming) return;

    const timer = window.setInterval(() => {
      const target = targetRef.current;
      const current = visibleRef.current;
      if (current === target) return;

      // Reveal everything received so far. Complete lines render as Markdown
      // while the trailing partial line renders as plain text (see below), so
      // a long paragraph streams character by character instead of waiting
      // for its closing newline and dumping in one piece.
      const next = target;
      if (next !== current) {
        visibleRef.current = next;
        setVisible(next);
      }
    }, LINE_TICK_MS);

    return () => window.clearInterval(timer);
  }, [isStreaming]);

  return visible;
}

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

  const visible = useLineBufferedText(
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

  return (
    <>
      {stable && <SessionMarkdown content={stable} className={className} />}
      {pending && fencePending && (
        <pre className="markdown-stream-pending agent-conversation-copy">
          <code>{pending}</code>
        </pre>
      )}
      {pending && !fencePending && (
        <span className="markdown-stream-tail agent-conversation-copy">
          {pending}
        </span>
      )}
    </>
  );
}
