import { memo } from "react";
import { useShellStore } from "../../shared/state/shellStore";
import type { TurnContentBlock } from "./buildInterleavedTurns";
import { toolBlocksToBatches } from "./toolCallUtils";
import { ThinkingBlock } from "./ThinkingBlock";
import { hasDisplayableReasoning } from "./activityText";
import { ToolCallBatchSummaryLine } from "./ToolCallBatchSummaryLine";

interface Props {
  toolBlocks: TurnContentBlock[];
  maxHeight?: string;
  isStreaming?: boolean;
  rememberKey?: string;
}

function sameToolBlocks(
  previous: TurnContentBlock[],
  next: TurnContentBlock[],
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    const a = previous[index];
    const b = next[index];
    if (a === b) continue;
    if (a.type !== b.type) return false;
    if (a.type === "thinking" && b.type === "thinking") {
      if (a.content !== b.content) return false;
      continue;
    }
    if (a.type === "tool_call" && b.type === "tool_call") {
      if (a.call !== b.call) return false;
      continue;
    }
    if (a.type === "tool_call_group" && b.type === "tool_call_group") {
      if (
        a.calls.length !== b.calls.length ||
        a.calls.some((call, callIndex) => call !== b.calls[callIndex])
      )
        return false;
      continue;
    }
    return false;
  }
  return true;
}

export const ToolCallRoundPanel = memo(function ToolCallRoundPanel({
  toolBlocks: rawToolBlocks,
  isStreaming = false,
  rememberKey,
}: Props) {
  const showThinking = useShellStore((state) => state.preferences.sessionShowThinking);
  const toolBlocks = rawToolBlocks.filter(
    (block) =>
      block.type === "tool_call" || block.type === "tool_call_group" ||
      (block.type === "thinking" && showThinking && hasDisplayableReasoning(block.content)),
  );
  if (toolBlocks.length === 0) return null;

  return (
    <div className="bui-tool-group bui-tool-list session-flow-tools">
      {toolBlocks.flatMap((block, index) =>
        block.type === "thinking" ? (
          <ThinkingBlock
            key={`thinking:${index}`}
            content={block.content}
            isStreaming={isStreaming && index === toolBlocks.length - 1}
            rememberKey={rememberKey ? `${rememberKey}:thinking:${index}` : undefined}
          />
        ) : toolBlocksToBatches([block]).map((batch) => (
          <ToolCallBatchSummaryLine
            key={`${batch.toolId}-${batch.calls[0]?.id}`}
            batch={batch}
            rememberKey={rememberKey}
          />
        )),
      )}
    </div>
  );
}, (previous, next) =>
  previous.maxHeight === next.maxHeight &&
  previous.isStreaming === next.isStreaming &&
  previous.rememberKey === next.rememberKey &&
  sameToolBlocks(previous.toolBlocks, next.toolBlocks),
);
