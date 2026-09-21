import { InteractionCard } from "./AgentInteractionPanel";
import { MediaParts } from "../media/MediaParts";
import { memo } from "react";
import { AlertCircle, ChevronRight, ShieldPlus } from "lucide-react";
import { useLocale } from "../../../hooks/useLocale";
import type { ConversationTimelineEntry } from "./buildConversationTimeline";
import { TurnBody } from "./TurnBody";
import { UserMessageBlock } from "./UserMessageBlock";
import { WorkLogEntry } from "./WorkLogEntry";

/**
 * Body of a single transcript entry. The scroll anchor id / data attribute live
 * on the wrapping `TimelineLazyEntry`, which is always in the DOM, so this
 * component must not repeat them.
 */
function SystemInjectionChip({ content }: { content: string }) {
  const chars = content.length;
  return (
    <details className="session-injection">
      <summary className="session-injection-chip">
        <ShieldPlus size={11} className="shrink-0" />
        <span>已注入系统提示</span>
        <span className="session-injection-size">
          {chars.toLocaleString()} 字
        </span>
        <ChevronRight size={11} className="session-injection-caret shrink-0" />
      </summary>
      <pre className="session-injection-body">{content}</pre>
    </details>
  );
}

export const TimelineEntryView = memo(function TimelineEntryView({
  entry,
  onExpandChild,
  isStreaming = false,
  isWorking = isStreaming,
}: {
  entry: ConversationTimelineEntry;
  onExpandChild?: (sessionId: string) => void;
  isStreaming?: boolean;
  isWorking?: boolean;
}) {
  const { locale } = useLocale();
  if (entry.kind === "error") {
    return (
      <div
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
  if (entry.kind === "interaction")
    return (
      <InteractionCard
        interaction={entry.interaction}
        disabled={entry.disabled}
      />
    );
  if (entry.kind === "user") {
    // App-composed prompts (language directive + wiki context + instructions)
    // are scaffolding, not conversation: collapse them into an indicator the
    // reader can expand if they actually want to inspect the payload.
    if (entry.injected) {
      return (
        <>
          <SystemInjectionChip content={entry.content} />
          <MediaParts parts={entry.contentParts} />
        </>
      );
    }
    return (
      <UserMessageBlock
        messageId={entry.id}
        content={entry.content}
        contentParts={entry.contentParts}
      />
    );
  }

  if (entry.kind === "work_log") {
    return <WorkLogEntry entry={entry} onExpandChild={onExpandChild} />;
  }

  return (
    <TurnBody
      isStreaming={isStreaming}
      isWorking={isWorking}
      turn={entry.turn}
      entryId={entry.id}
      onExpandChild={onExpandChild}
    />
  );
});
