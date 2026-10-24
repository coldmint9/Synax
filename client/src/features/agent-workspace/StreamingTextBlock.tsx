import { hideVisualizationSource } from "./visualizationTranscript";
import { memo, useLayoutEffect, useRef } from "react";
import { paintFirstToken } from "../../adapters/transport/firstTokenTiming";
import { BufferedMarkdown } from "./BufferedMarkdown";
import { hasVisualization } from "../../../../services/local-node/modules/agent-runtime/visualization-protocol";
import { VisualizationLoading } from "../visualizations/VisualizationLoading";
import { useStreamingText } from "./useStreamingText";

interface Props {
  text: string;
  stepId?: string;
  isStreaming: boolean;
  markdown?: boolean;
  startDelayMs?: number;
}

export const StreamingTextBlock = memo(function StreamingTextBlock({
  text,
  stepId,
  isStreaming,
  markdown = false,
  startDelayMs = 0,
}: Props) {
  const containsVisualization = isStreaming && hasVisualization(text);
  text = hideVisualizationSource(text, isStreaming);
  const visible = useStreamingText(text, isStreaming && !markdown);
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!stepId || !text || !root.current) return;
    const node = root.current;
    let frame = 0, next = 0;
    // Buffered Markdown can commit its first text after its parent layout
    // effect. Observe only until that first visible commit, never per token.
    const observer = new MutationObserver(check);
    function check() {
      if (frame || !node.textContent?.trim()) return;
      observer.disconnect();
      frame = requestAnimationFrame(() => {
        next = requestAnimationFrame(() => paintFirstToken(stepId!));
      });
    }
    observer.observe(node, { subtree: true, childList: true, characterData: true });
    check();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); cancelAnimationFrame(next); };
  }, [stepId, Boolean(text)]);
  if (!text && !isStreaming) return null;

  if (markdown) {
    return (
      <div ref={root} data-stream-text-step={stepId}>
        <BufferedMarkdown
          content={text}
          isStreaming={isStreaming}
          startDelayMs={startDelayMs}
          className="feed-prose"
        />
        {containsVisualization && <VisualizationLoading />}
      </div>
    );
  }

  return (
    <div ref={root} data-stream-text-step={stepId} className="agent-conversation-copy leading-[1.75] text-foreground whitespace-pre-wrap">
      {visible.split(/\n{2,}/).map((paragraph, index, paragraphs) => (
        <p key={index} className="session-text-paragraph">
          {paragraph}
          {isStreaming && index === paragraphs.length - 1 && (
            <span className="inline-block w-0.5 h-[1em] bg-foreground/60 animate-pulse ml-0.5 align-text-bottom" />
          )}
        </p>
      ))}
    </div>
  );
});
