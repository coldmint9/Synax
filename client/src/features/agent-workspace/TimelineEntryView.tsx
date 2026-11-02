import { ContextCompactionFeedback } from "./ContextCompactionFeedback";
import { InteractionCard } from "./AgentInteractionPanel";
import { memo } from "react";
import { AlertCircle } from "lucide-react";
import { useLocale } from "../../shared/hooks/useLocale";
import type { ConversationTimelineEntry } from "./buildConversationTimeline";
import { TurnBody } from "./TurnBody";
import { UserMessageBlock } from "./UserMessageBlock";
import { WorkLogEntry } from "./WorkLogEntry";

/**
 * Body of a single transcript entry. The scroll anchor id / data attribute live
 * on the wrapping `TimelineLazyEntry`, which is always in the DOM, so this
 * component must not repeat them.
 */
function displayModelName(model: string): string {
  const separator = model.indexOf("/");
  return separator < 0 ? model : model.slice(separator + 1);
}

export const TimelineEntryView = memo(function TimelineEntryView({
  entry,
  onExpandChild,
  isStreaming = false,
  isWorking = isStreaming,
  showsHiddenReasoning = false,
  foldFrom,
}: {
  entry: ConversationTimelineEntry;
  onExpandChild?: (sessionId: string) => void;
  isStreaming?: boolean;
  isWorking?: boolean;
  showsHiddenReasoning?: boolean;
  /** Height of the process rows a just-folded round replaced. */
  foldFrom?: number;
}) {
  const { locale } = useLocale();
  if (entry.kind === "compaction")
    return <ContextCompactionFeedback state={entry.state} />;
  if (entry.kind === "error") {
    return (
      <div
        data-error-toast="off"
        role="alert"
        className="rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm"
      >
        <div className="flex items-center gap-2 font-medium text-destructive">
          <AlertCircle size={16} aria-hidden="true" />
          {locale === "zh" ? "请求失败" : "Request failed"}
        </div>
        {entry.model && (
          <div className="mt-1 break-all text-xs text-muted-foreground">
            {entry.model}
          </div>
        )}
        <p className="mt-2 whitespace-pre-wrap break-words text-destructive">
          {entry.message}
        </p>
      </div>
    );
  }
  if (entry.kind === "model_switch") {
    return (
      <div className="flex justify-center" role="status">
        <span className="rounded-full bg-secondary/60 px-3 py-1 text-[11px] text-muted-foreground">
          {locale === "zh"
            ? `模型已从 ${displayModelName(entry.fromModel)} 切换至 ${displayModelName(entry.toModel)}`
            : `Model switched from ${displayModelName(entry.fromModel)} to ${displayModelName(entry.toModel)}`}
        </span>
      </div>
    );
  }
  if (entry.kind === "interaction")
    return (
      <InteractionCard
        interaction={entry.interaction}
        disabled={entry.disabled}
      />
    );
  if (entry.kind === "user") {
    return (
      <UserMessageBlock
        messageId={entry.id}
        content={entry.content}
        contentParts={entry.contentParts}
        references={entry.references}
      />
    );
  }

  if (entry.kind === "work_log") {
    return (
      <WorkLogEntry
        entry={entry}
        onExpandChild={onExpandChild}
        foldFrom={foldFrom}
      />
    );
  }

  return (
    <TurnBody
      isStreaming={isStreaming}
      isWorking={isWorking}
      showsHiddenReasoning={showsHiddenReasoning}
      turn={entry.turn}
      entryId={entry.id}
      showActions={entry.finalReply === true}
      onExpandChild={onExpandChild}
    />
  );
});
