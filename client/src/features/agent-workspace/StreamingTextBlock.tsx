import { hideVisualizationSource } from "./visualizationTranscript";
import { memo } from "react";
import { BufferedMarkdown } from "./BufferedMarkdown";
import { hasVisualization } from "../../../../services/local-node/modules/agent-runtime/visualization-protocol";
import { VisualizationLoading } from "../visualizations/VisualizationLoading";
import { useStreamingText } from "./useStreamingText";

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
  const containsVisualization = isStreaming && hasVisualization(text);
  text = hideVisualizationSource(text, isStreaming);
  const visible = useStreamingText(text, isStreaming && !markdown);
  if (!text && !isStreaming) return null;

  if (markdown) {
    return (
      <>
        <BufferedMarkdown
          content={text}
          isStreaming={isStreaming}
          startDelayMs={startDelayMs}
          className="feed-prose"
        />
        {containsVisualization && <VisualizationLoading />}
      </>
    );
  }

  return (
    <div className="agent-conversation-copy leading-[1.75] text-foreground whitespace-pre-wrap">
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
