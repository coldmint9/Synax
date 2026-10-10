import { useEffect, useState } from "react";
import { agentRuntimeApi, type AgentRuntimeMessage } from "../../adapters/transport/agentRuntime";
import { InlineVisualization } from "../visualizations/InlineVisualization";
import { VisualizationLoading } from "../visualizations/VisualizationLoading";
import { Button } from "../../shared/ui/ui/Button";
import { StreamingTextBlock } from "./StreamingTextBlock";
import { hideVisualizationSource, visualizationReplyParts } from "./visualizationTranscript";

/** Restore the complete saved reply, including offsets, after a bounded history
 * projection omitted its HTML. Never reconstruct executable HTML from text. */
export default function HistoricalVisualizationReply({ message }: { message: AgentRuntimeMessage }) {
  const [result, setResult] = useState<{ message: AgentRuntimeMessage | null }>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setResult(undefined);
    setFailed(false);
    agentRuntimeApi.messageVisualization(message.sessionId, message.id).then(
      (value) => { if (active) setResult(value); },
      () => { if (active) setFailed(true); },
    );
    return () => { active = false; };
  }, [message.sessionId, message.id, attempt]);

  if (failed) return <div role="alert">
    预览加载失败。
    <Button size="sm" onClick={() => setAttempt((value) => value + 1)}>重试</Button>
  </div>;
  if (!result) return <VisualizationLoading />;
  if (!result.message) return <StreamingTextBlock
    text={hideVisualizationSource(message.content)} isStreaming={false} markdown />;
  return <>{visualizationReplyParts({ ...result.message, historyProjection: undefined }).map((part, index) =>
    part.type === "visualization"
      ? <InlineVisualization key={part.reference.id} visualization={part.reference} />
      : <StreamingTextBlock key={`text:${index}`} text={part.content} isStreaming={false} markdown />,
  )}</>;
}
