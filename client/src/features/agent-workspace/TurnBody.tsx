import { lazy, Suspense, useId, useState } from "react";
import { Button as HeadlessButton } from "@headlessui/react";
const HistoricalVisualizationReply = lazy(() => import("./HistoricalVisualizationReply"));
const InlineVisualization = lazy(() =>
  import("../visualizations/InlineVisualization").then((module) => ({
    default: module.InlineVisualization,
  })),
);
import type { InlineVisualizationReference } from "./visualizationTranscript";
import { MessageActionToolbar } from "./MessageActionToolbar";
import { useSessionHistory } from "./SessionHistoryContext";
import { useShellStore } from "../../shared/state/shellStore";
import { MessageSquare, Zap } from "lucide-react";
import { useLocale } from "../../shared/hooks/useLocale";
import { ActivityStatus } from "../../shared/ui/beautiful-ui/ActivityStatus";
import { aggregateToolStatus } from "./toolCallPresentation";
import {
  activityPreview,
  hasDisplayableReasoning,
  latestActivityPreview,
  thinkingBannerPhrase,
} from "./activityText";
import { useActivityDisclosure } from "./useActivityDisclosure";
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
import { buildTurnRenderSegments, flattenToolBlocks } from "./toolCallUtils";
import "./conversationFlow.css";

function TranscriptVisualization({
  reference,
}: {
  reference: InlineVisualizationReference;
}) {
  return (
    <Suspense
      fallback={
        <div className="text-xs text-muted-foreground" role="status">
          正在加载预览…
        </div>
      }
    >
      {reference.historyMessage
        ? <HistoricalVisualizationReply key={reference.id} message={reference.historyMessage} />
        : <InlineVisualization visualization={reference} />}
    </Suspense>
  );
}
function sourceLabel(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Tail of the newest thought still streaming into this turn.
 *
 * A live process row reads as "where is the model now", so it shows the end of
 * the latest reasoning instead of a call count. Headline-only reasoning
 * (`**Inspecting routes**`) has no prose to read from, so its last headline is
 * the preview.
 */
function latestThinkingTail(
  blocks: readonly TurnContentBlock[],
  max = 60,
): string | null {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.type !== "thinking" || !block.content.trim()) continue;
    const banner = thinkingBannerPhrase(block.content);
    const tail = banner
      ? activityPreview(banner, max)
      : latestActivityPreview(block.content, max);
    if (tail) return tail;
  }
  return null;
}

function segmentKey(
  segment: (ReturnType<typeof buildTurnRenderSegments>)[number],
  index: number,
): string {
  if (segment.type === "visualization") return `visualization:${segment.reference.id}`;
  if (segment.type === "media") return `media:${segment.messageId ?? index}`;
  if (segment.type === "sources")
    return `sources:${segment.sources.map((source) => source.id).join(",") || index}`;
  if (segment.type === "tool_round") {
    const ids = segment.toolBlocks.flatMap((block) =>
      block.type === "tool_call"
        ? [block.call.id]
        : block.type === "tool_call_group"
          ? block.calls.map((call) => call.id)
          : [],
    );
    // Appending a call must not remount the already-open rows in this round.
    return `tool-round:${ids[0] ?? index}`;
  }
  if (segment.type === "thinking") return `thinking:${index}`;
  if (segment.type === "text") return `text:${index}`;
  if (segment.type === "sub_session") return `sub-session:${segment.session.id}`;
  return `context-compacted:${index}`;
}

export function TurnContent({
  blocks,
  onExpandChild,
  rowKeyPrefix = "",
  isStreaming = false,
  isWorking = isStreaming,
  defaultExpanded = true,
  processOnly = false,
  processMeta,
  processPreview,
}: {
  blocks: readonly TurnContentBlock[];
  onExpandChild?: (sessionId: string) => void;
  rowKeyPrefix?: string;
  isStreaming?: boolean;
  isWorking?: boolean;
  defaultExpanded?: boolean;
  processOnly?: boolean;
  processMeta?: string;
  processPreview?: string | null;
}) {
  const { locale } = useLocale();
  const [expanded, toggle] = useActivityDisclosure(rowKeyPrefix ? `process:${rowKeyPrefix}` : undefined, defaultExpanded);
  // A live turn keeps growing after it mounts: rows appended while it streams
  // reveal themselves so new tool rounds read as a continuation, not a pop.
  // Frozen at mount, so a finished turn never replays the reveal.
  const [appendReveal] = useState(isStreaming);
  const flowId = useId();
  const segments = buildTurnRenderSegments(blocks).filter(
    (segment) => segment.type !== "thinking" || hasDisplayableReasoning(segment.content),
  );
  const calls = flattenToolBlocks(blocks);
  let lastActivity = -1;
  segments.forEach((segment, index) => {
    if (segment.type === "thinking" || segment.type === "tool_round") lastActivity = index;
  });
  if (processOnly && segments.length) lastActivity = segments.length - 1;
  const hasActivity = lastActivity >= 0;
  const toolStatus = calls.length ? aggregateToolStatus(calls) : "completed";
  const status = isWorking && toolStatus === "completed" ? "running" : toolStatus;
  const failure = calls.find((call) => call.status === "failed" || call.status === "denied");
  const foldedPreview = failure?.outputSummary ? activityPreview(failure.outputSummary, 180) : processPreview;
  // Only a live row ticks: history keeps the call-count summary, which is the
  // part that stays true once the turn has stopped thinking.
  const thinkingTail = isWorking ? latestThinkingTail(blocks) : null;
  const tickerText = thinkingTail
    ? locale === "zh"
      ? `正在思考:「${thinkingTail}」`
      : `Thinking: "${thinkingTail}"`
    : null;
  const render = (segment: (typeof segments)[number], i: number) => {
    const key = segmentKey(segment, i);
    if (segment.type === "visualization")
      return (
        <TranscriptVisualization
          key={key}
          reference={segment.reference}
        />
      );
    if (segment.type === "media")
      return <MediaParts key={key} parts={segment.parts} />;
    if (segment.type === "thinking")
      return (
        <ThinkingBlock
          isStreaming={isStreaming && segment === segments[segments.length - 1]}
          key={key}
          content={segment.content}
          rememberKey={rowKeyPrefix ? `${rowKeyPrefix}:${key}` : undefined}
        />
      );
    if (segment.type === "tool_round")
      return <ToolCallRoundPanel key={key} toolBlocks={segment.toolBlocks} isStreaming={isWorking} rememberKey={rowKeyPrefix ? `${rowKeyPrefix}:${key}` : undefined} />;
    if (segment.type === "text")
      return (
        <StreamingTextBlock
          key={key}
          text={segment.content}
          isStreaming={isStreaming && segment === segments[segments.length - 1]}
          markdown={segment.markdown}
        />
      );
    if (segment.type === "sources")
      return (
        <div key={key} className="mt-2 flex flex-wrap gap-1.5">
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
          key={key}
          session={segment.session}
          onExpand={onExpandChild}
        />
      );
    if (segment.type === "context_compacted")
      return (
        <div
          key={key}
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
    <div
      className={
        appendReveal
          ? "session-conversation-flow session-flow-append"
          : "session-conversation-flow"
      }
      data-has-activity={hasActivity || undefined}
    >
      {hasActivity && (
        <HeadlessButton
          type="button"
          className="session-process-trigger"
          aria-expanded={expanded}
          aria-controls={segments.slice(0, lastActivity + 1).map((_, i) => `${flowId}-${i}`).join(" ")}
          aria-label={tickerText ?? undefined}
          onClick={toggle}
        >
          {tickerText ? (
            <span className="session-process-ticker" aria-hidden="true">
              <span className="session-process-ticker-track">
                <span className="session-process-ticker-copy">{tickerText}</span>
                <span className="session-process-ticker-copy" aria-hidden="true">{tickerText}</span>
              </span>
            </span>
          ) : (
            <>
              <span>{locale === "zh" ? "处理过程" : "Process"}</span>
              {calls.length > 0 && <span>{locale === "zh" ? `${calls.length} 次工具调用` : `${calls.length} tool calls`}</span>}
              {processMeta && <span>{processMeta}</span>}
            </>
          )}
          {status !== "running" && (
            <span className="session-process-status"><ActivityStatus status={status} /></span>
          )}
        </HeadlessButton>
      )}
      {!expanded && foldedPreview && <div className="session-process-preview" data-error={Boolean(failure) || undefined}>{foldedPreview}</div>}
      <div className="session-flow-content">
        {segments.map((segment, index) => {
          const inProcess = index <= lastActivity;
          const activity = segment.type === "thinking" || segment.type === "tool_round";
          return (
            <div
              key={segmentKey(segment, index)}
              id={`${flowId}-${index}`}
              className={activity ? "session-flow-entry" : "session-flow-entry session-answer-region"}
              data-process={inProcess || undefined}
              data-activity={activity || undefined}
              data-answer-start={hasActivity && index === lastActivity + 1 || undefined}
              hidden={inProcess && !expanded}
            >
              {(!inProcess || expanded) && <>
                {inProcess && !activity && <MessageSquare className="session-flow-comment-icon" size={16} aria-hidden="true" />}
                {render(segment, index)}
              </>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
/** One agent turn. Turn duration separators are intentionally omitted from the transcript. */
export function TurnBody({
  turn,
  entryId,
  onExpandChild,
  isStreaming = false,
  isWorking = isStreaming,
  showActions = true,
}: {
  turn: InterleavedTurn;
  entryId: string;
  onExpandChild?: (sessionId: string) => void;
  isStreaming?: boolean;
  isWorking?: boolean;
  /**
   * Whether this row is the round's final reply. Process rows leave the
   * copy / fork / rollback toolbar to that row instead of mounting an idle
   * placeholder under every step.
   */
  showActions?: boolean;
}) {
  const history = useSessionHistory();
  const showThinking = useShellStore((state) => state.preferences.sessionShowThinking);
  const visibleBlocks = showThinking
    ? turn.blocks
    : turn.blocks.filter((block) => block.type !== "thinking");
  const textBlocks = turn.blocks.filter((block) => block.type === "text");
  const messageId =
    textBlocks[textBlocks.length - 1]?.messageId ??
    turn.blocks.find(
      (block) => block.type === "media" || block.type === "visualization",
    )?.messageId;
  const checkpoint = history?.checkpoint(messageId, turn.stepId);
  const text = textBlocks.map((block) => block.content).join("\n\n");
  const hasAnswer = Boolean(
    text ||
    turn.blocks.some(
      (block) => block.type === "media" || block.type === "visualization",
    ),
  );
  return (
    <div className="session-turn-content message-action-group flex min-w-0 flex-1 flex-col gap-1">
      {isWorking && visibleBlocks.length === 0 ? (
        <ThinkingIndicator />
      ) : (
        <TurnContent blocks={visibleBlocks} onExpandChild={onExpandChild} rowKeyPrefix={entryId} isStreaming={isStreaming} isWorking={isWorking} />
      )}
      {hasAnswer && showActions && (
        <MessageActionToolbar
          role="assistant"
          text={text}
          timestamp={isStreaming ? null : turn.completedAt}
          disabledReason={history?.reason || checkpoint?.reason || undefined}
          forkDisabledReason={history?.forkReason || checkpoint?.reason || null}
          rollbackDisabled={
            checkpoint
              ? checkpoint.canRollback === false ||
                (!checkpoint.hasLaterHistory && !history?.running)
              : false
          }
          rollbackDisabledReason={
            checkpoint?.canRollback === false
              ? "分叉会话不支持回滚 / Forked conversations are append-only"
              : undefined
          }
          busy={history?.busy}
          onFork={
            checkpoint?.available
              ? (mode) => {
                  void history?.request("fork", checkpoint, undefined, mode);
                }
              : undefined
          }
          onRollback={
            checkpoint?.available && checkpoint.canRollback !== false
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
