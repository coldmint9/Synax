import { memo } from "react";
import { Wrench } from "lucide-react";
import { useLocale } from "../../shared/hooks/useLocale";
import { ThinkingTrace } from "./ThinkingTrace";
import type { TurnContentBlock } from "./buildInterleavedTurns";
import { toolBlocksToBatches } from "./toolCallUtils";
import { ThinkingBlock } from "./ThinkingBlock";
import { PixelLoader } from "./LoadingState";
import {
  hasDisplayableReasoning,
  latestActivityPreview,
} from "./activityText";
import { ToolCallBatchSummaryLine } from "./ToolCallBatchSummaryLine";
import { toolCallPresentation } from "./toolCallPresentation";

interface Props {
  toolBlocks: TurnContentBlock[];
  maxHeight?: string;
  isStreaming?: boolean;
}

export const ToolCallRoundPanel = memo(function ToolCallRoundPanel({
  toolBlocks: rawToolBlocks,
  maxHeight = "160px",
  isStreaming = false,
}: Props) {
  const { t, locale } = useLocale();
  const toolBlocks = rawToolBlocks.filter(
    (block) =>
      block.type !== "thinking" || hasDisplayableReasoning(block.content),
  );
  // Only the newest thought mounts its row here; the earlier ones are read-only
  // history and would each add a collapsed row that can never change again.
  // Keep this row out of the source-order loop: new tool calls must append
  // without moving the thinking DOM node through the list.
  const latestThought = [...toolBlocks]
    .reverse()
    .find((block) => block.type === "thinking");
  const activityBlocks = toolBlocks.filter(
    (block) => block.type !== "thinking",
  );
  const previews = toolBlocks
    .flatMap((block, index) => {
      // Each record previews its latest line: a row reports where the round is
      // now, not the first thing it said.
      if (block.type === "thinking")
        return [
          {
            id: `thinking-${index}`,
            text: latestActivityPreview(
              block.content.replace(/\*\*/g, ""),
              160,
            ),
          },
        ];
      const calls =
        block.type === "tool_call"
          ? [block.call]
          : block.type === "tool_call_group"
            ? block.calls
            : [];
      return calls.map((call) => {
        const { name, target } = toolCallPresentation(call, locale);
        return {
          id: call.id,
          text: target ? `${name} · ${latestActivityPreview(target, 140)}` : name,
        };
      });
    })
    .filter((item) => item.text)
    .slice(-4);
  // Only new runtime activity changes the preview; an idle round never cycles.
  const preview = previews[previews.length - 1];
  if (toolBlocks.length === 0) return null;
  const batches = toolBlocksToBatches(toolBlocks);
  const calls = batches.flatMap((batch) => batch.calls);

  return (
    <div className="bui-tool-group">
      <ThinkingTrace
        label={preview?.text ?? t("sessionActivityThinking")}
        title={preview?.text}
        meta={
          calls.length
            ? t("sessionWorkLogCalls", { count: calls.length })
            : null
        }
        working={isStreaming}
        variant="coding"
        icon={
          isStreaming ? (
            <PixelLoader />
          ) : calls.length ? (
            <Wrench size={16} aria-hidden="true" />
          ) : undefined
        }
        maxHeight={maxHeight}
      >
        <div className="bui-tool-list">
          {activityBlocks.flatMap((block) =>
            toolBlocksToBatches([block]).map((batch) => (
              <ToolCallBatchSummaryLine
                key={`${batch.toolId}-${batch.calls[0]?.id}`}
                batch={batch}
              />
            )),
          )}
          {latestThought?.type === "thinking" ? (
            <ThinkingBlock
              key="thinking-latest"
              content={latestThought.content}
              isStreaming={
                isStreaming &&
                toolBlocks[toolBlocks.length - 1] === latestThought
              }
            />
          ) : null}
        </div>
      </ThinkingTrace>
    </div>
  );
});
