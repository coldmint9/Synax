import { memo, type ReactNode } from "react";
import { useShellStore } from "../../shared/state/shellStore";
import type { TurnContentBlock } from "./buildInterleavedTurns";
import { toolBlocksToBatches } from "./toolCallUtils";
import { ThinkingBlock } from "./ThinkingBlock";
import { hasDisplayableReasoning } from "./activityText";
import { ToolCallSummaryLine } from "./ToolCallSummaryLine";
import { ToolCallBatchSummaryLine } from "./ToolCallBatchSummaryLine";
import type { ToolFileLinks } from "./fileLink";

export interface ToolRoundRow {
  key: string;
  node: ReactNode;
}

interface Props {
  toolBlocks: TurnContentBlock[];
  maxHeight?: string;
  isStreaming?: boolean;
  rememberKey?: string;
}

/**
 * One row per record: a thought, or one call batch.
 *
 * The transcript window and the standalone round panel both lay rows out this
 * way, so a round looks the same whether it is streamed or replayed.
 */
export function toolRoundRows(
  toolBlocks: readonly TurnContentBlock[],
  {
    isStreaming = false,
    rememberKey,
    individual = false,
    fileLinks,
  }: {
    isStreaming?: boolean;
    rememberKey?: string;
    individual?: boolean;
    fileLinks?: ToolFileLinks;
  } = {},
): ToolRoundRow[] {
  const rows: ToolRoundRow[] = [];
  toolBlocks.forEach((block, index) => {
    if (block.type === "thinking") {
      if (!hasDisplayableReasoning(block.content)) return;
      const key = `thinking:${index}`;
      rows.push({
        key,
        node: (
          <ThinkingBlock
            key={key}
            content={block.content}
            isStreaming={isStreaming && index === toolBlocks.length - 1}
            rememberKey={rememberKey ? `${rememberKey}:${key}` : undefined}
          />
        ),
      });
      return;
    }
    if (block.type !== "tool_call" && block.type !== "tool_call_group") return;
    if (individual) {
      const calls = block.type === "tool_call" ? [block.call] : block.calls;
      for (const call of calls) rows.push({
        key: `call:${call.id}`,
        node: <ToolCallSummaryLine key={call.id} call={call} rememberKey={rememberKey} fileLinks={fileLinks} />,
      });
      return;
    }
    toolBlocksToBatches([block]).forEach((batch) => {
      const key = `${batch.toolId}-${batch.calls[0]?.id}`;
      rows.push({
        key,
        node: (
          <ToolCallBatchSummaryLine key={key} batch={batch} rememberKey={rememberKey} />
        ),
      });
    });
  });
  return rows;
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
      {toolRoundRows(toolBlocks, { isStreaming, rememberKey }).map((row) => row.node)}
    </div>
  );
});
