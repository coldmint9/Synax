import { hideVisualizationSource } from "./visualizationTranscript";
import { memo } from "react";
import { BufferedMarkdown } from "./BufferedMarkdown";

interface Props {
  text: string;
  isStreaming: boolean;
  markdown?: boolean;
  startDelayMs?: number;
}

export const StreamingTextBlock = memo(function StreamingTextBlock({
  text,
  isStreaming,
  markdown = false,
  startDelayMs = 0,
}: Props) {
  text = hideVisualizationSource(text, isStreaming);
  if (!text && !isStreaming) return null;

  if (markdown) {
    return (
      <BufferedMarkdown
        content={text}
        isStreaming={isStreaming}
        startDelayMs={startDelayMs}
        className="feed-prose"
      />
    );
  }

  return (
    <div className="agent-conversation-copy leading-[1.75] text-foreground whitespace-pre-wrap">
      {text}
      {isStreaming && (
        <span className="inline-block w-0.5 h-[1em] bg-foreground/60 animate-pulse ml-0.5 align-text-bottom" />
      )}
    </div>
  );
});
