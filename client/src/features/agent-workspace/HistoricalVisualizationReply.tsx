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

  if (failed) return <div data-error-toast="off" role="alert">
    预览加载失败。
    <Button size="sm" onClick={() => setAttempt((value) => value + 1)}>重试</Button>
  </div>;
  if (!result) return <VisualizationLoading />;
  // A saved reply can point at a snapshot the server no longer holds: the file
  // moved, was deleted, or sat outside the session workspace. Say that instead
  // of the misleading “preview was not generated” copy, and allow a retry.
  if (!result.message) return <>
    <StreamingTextBlock
      text={hideVisualizationSource(message.content)} isStreaming={false} markdown />
    <div className="inline-visualization__error" data-error-toast="off" role="alert">
      <strong>预览快照不可用</strong>
      <span>文件可能已移动、删除，或不在当前会话工作区内。请让助手重新生成这个预览。</span>
      <div>
        <Button size="sm" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>
          重试加载
        </Button>
      </div>
    </div>
  </>;
  return <>{visualizationReplyParts({ ...result.message, historyProjection: undefined }).map((part, index) =>
    part.type === "visualization"
      ? <InlineVisualization key={part.reference.id} visualization={part.reference} />
      : <StreamingTextBlock key={`text:${index}`} text={part.content} isStreaming={false} markdown />,
  )}</>;
}
