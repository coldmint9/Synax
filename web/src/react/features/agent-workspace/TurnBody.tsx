import { MessageActionToolbar } from "./MessageActionToolbar";
import { useSessionHistory } from "./SessionHistoryContext";
import { Zap } from "lucide-react";
import { MediaParts } from "../media/MediaParts";
import type {
  InterleavedTurn,
  TurnContentBlock,
} from "./buildInterleavedTurns";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallRoundPanel } from "./ToolCallRoundPanel";
import { StreamingTextBlock } from "./StreamingTextBlock";
import { SubSessionCard } from "./SubSessionCard";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { buildTurnRenderSegments } from "./toolCallUtils";

function sourceLabel(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function renderTurnBlocks(
  blocks: TurnContentBlock[],
  onExpandChild?: (sessionId: string) => void,
  rowKeyPrefix = "",
  isStreaming = false,
  isWorking = isStreaming,
) {
  const segments = buildTurnRenderSegments(blocks);
  const toolBlocks = blocks.filter(
    (block) =>
      block.type === "thinking" ||
      block.type === "tool_call" ||
      block.type === "tool_call_group",
  );
  const answers = segments.filter(
    (segment) =>
      segment.type !== "tool_round" &&
      (toolBlocks.length === 0 || segment.type !== "thinking"),
  );
  const render = (segment: (typeof segments)[number], i: number) => {
    if (segment.type === "media")
      return <MediaParts key={i} parts={segment.parts} />;
    if (segment.type === "thinking")
      return (
        <ThinkingBlock
          isStreaming={isStreaming && segment === segments[segments.length - 1]}
          key={i}
          content={segment.content}
          rememberKey={rowKeyPrefix ? `${rowKeyPrefix}:${i}` : undefined}
        />
      );
    if (segment.type === "tool_round")
      return <ToolCallRoundPanel key={i} toolBlocks={segment.toolBlocks} />;
    if (segment.type === "text")
      return (
        <StreamingTextBlock
          key={i}
          text={segment.content}
          isStreaming={isStreaming && segment === segments[segments.length - 1]}
          markdown={segment.markdown}
        />
      );
    if (segment.type === "sources")
      return (
        <div key={i} className="mt-2 flex flex-wrap gap-1.5">
          {segment.sources.map((source, index) => (
            <a
              key={source.id}
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="max-w-full truncate rounded-md border border-default-200 px-2 py-1 text-[11px] text-primary hover:bg-default-100"
              title={source.title || source.url}
            >
              {index + 1}. {source.title || sourceLabel(source.url)}
            </a>
          ))}
        </div>
      );
    if (segment.type === "sub_session")
      return (
        <SubSessionCard
          key={i}
          session={segment.session}
          onExpand={onExpandChild}
        />
      );
    if (segment.type === "context_compacted")
      return (
        <div
          key={i}
          className="flex items-center gap-2 rounded-md border border-warning/20 bg-warning/5 px-3 py-1.5 text-[11px] text-warning"
        >
          <Zap size={12} />
          <span>
            上下文压缩: {segment.originalTokens.toLocaleString()} →{" "}
            {segment.compressedTokens.toLocaleString()} tokens (
            {segment.messageCount} 条消息被摘要)
          </span>
        </div>
      );
    return null;
  };
  return (
    <>
      <div className="session-tool-region">
        {toolBlocks.length > 0 && (
          <ToolCallRoundPanel
            toolBlocks={toolBlocks}
            maxHeight="420px"
            isStreaming={isWorking}
          />
        )}
      </div>
      <div className="session-answer-region">{answers.map(render)}</div>
    </>
  );
}
/** One agent turn. Turn duration separators are intentionally omitted from the transcript. */
export function TurnBody({
  turn,
  entryId,
  onExpandChild,
  isStreaming = false,
  isWorking = isStreaming,
}: {
  turn: InterleavedTurn;
  entryId: string;
  onExpandChild?: (sessionId: string) => void;
  isStreaming?: boolean;
  isWorking?: boolean;
}) {
  const history = useSessionHistory();
  const textBlocks = turn.blocks.filter((block) => block.type === "text");
  const messageId =
    textBlocks[textBlocks.length - 1]?.messageId ??
    turn.blocks.find((block) => block.type === "media")?.messageId;
  const checkpoint = history?.checkpoint(messageId, turn.stepId);
  const text = textBlocks.map((block) => block.content).join("\n\n");
  const hasAnswer = Boolean(
    text || turn.blocks.some((block) => block.type === "media"),
  );
  return (
    <div className="session-turn-content message-action-group flex min-w-0 flex-1 flex-col gap-1">
      {isStreaming && turn.blocks.length === 0 ? (
        <ThinkingIndicator />
      ) : (
        renderTurnBlocks(
          turn.blocks,
          onExpandChild,
          entryId,
          isStreaming,
          isWorking,
        )
      )}
      {hasAnswer && (
        <MessageActionToolbar
          role="assistant"
          text={text}
          disabledReason={history?.reason || checkpoint?.reason || undefined}
          rollbackDisabled={checkpoint ? !checkpoint.hasLaterHistory : false}
          busy={history?.busy || isStreaming || isWorking}
          onFork={
            checkpoint?.available
              ? () => {
                  void history?.request("fork", checkpoint);
                }
              : undefined
          }
          onRollback={
            checkpoint?.available
              ? () => {
                  void history?.request("rollback", checkpoint);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
