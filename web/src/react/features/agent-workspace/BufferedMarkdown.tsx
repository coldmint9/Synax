import { useEffect, useRef, useState } from "react";
import { SessionMarkdown } from "./SessionMarkdown";

const LINE_TICK_MS = 32;
const PARTIAL_LINE_IDLE_MS = 140;

function useLineBufferedText(text: string, isStreaming: boolean): string {
  const targetRef = useRef(text);
  const visibleRef = useRef(isStreaming ? "" : text);
  const changedAtRef = useRef(Date.now());
  const [visible, setVisible] = useState(visibleRef.current);

  useEffect(() => {
    targetRef.current = text;
    changedAtRef.current = Date.now();
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

      const completeLineEnd = target.lastIndexOf("\n") + 1;
      const idle = Date.now() - changedAtRef.current >= PARTIAL_LINE_IDLE_MS;
      const next =
        completeLineEnd > current.length
          ? target.slice(0, completeLineEnd)
          : idle
            ? target
            : current;
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
  const { stable, pending } = isStreaming
    ? splitUnclosedFence(visible)
    : { stable: visible, pending: "" };

  return (
    <>
      {stable && <SessionMarkdown content={stable} className={className} />}
      {pending && (
        <pre className="markdown-stream-pending agent-conversation-copy">
          <code>{pending}</code>
        </pre>
      )}
    </>
  );
}
