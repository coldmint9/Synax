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
import { aggregateToolStatus, toolCallPresentation } from "./toolCallPresentation";
import {
  activityPreview,
  hasDisplayableReasoning,
  thinkingBannerPhrase,
} from "./activityText";
import { useActivityDisclosure } from "./useActivityDisclosure";
import { MediaParts } from "../media/MediaParts";
import type {
  InterleavedTurn,
  TurnContentBlock,
} from "./buildInterleavedTurns";
import { ThinkingBlock } from "./ThinkingBlock";
import { toolRoundRows } from "./ToolCallRoundPanel";
import { StreamingTextBlock } from "./StreamingTextBlock";
import { StreamingActivityLine } from "./StreamingActivityLine";
import {
  VirtualActivityWindow,
  type ActivityWindowRow,
} from "./VirtualActivityWindow";
import { SubSessionCard } from "./SubSessionCard";
import { ThinkingIndicator } from "./ThinkingIndicator";
import {
  buildTurnRenderSegments,
  flattenToolBlocks,
} from "./toolCallUtils";
import "./conversationFlow.css";

/** How much of the newest thought the live line keeps for its scrolling tail. */
const LINE_MAX_CHARS = 240;

/**
 * Continuous tail of a reasoning body, flattened for a single line.
 *
 * Reasoning arrives in paragraphs and list items; the live line wants the end
 * of what is being said, not the last item alone. Only the tail is normalised
 * so a 90k-character thought costs no more than a short one.
 */
function thoughtTail(content: string, max = LINE_MAX_CHARS): string {
  const cut = content.length > max ? content.slice(-max) : content;
  const tail = cut.replace(/\s+/g, " ").trim();
  return content.length > max ? `…${tail}` : tail;
}

function TranscriptVisualization({
  reference,
}: {
  reference: InlineVisualizationReference;
}) {
  return (
    <Suspense
      fallback={
        <div className="text-[11px] text-muted-foreground" role="status">
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
 * Newest activity of a live turn, formatted as the process line's content.
 *
 * A running turn moves between reasoning and calls, so the line reports
 * whichever came last: the tail of the newest thought, or the newest call with
 * its target. Past thoughts and calls keep their own rows below.
 */
function latestActivityLine(
  segments: ReturnType<typeof buildTurnRenderSegments>,
  zh: boolean,
): string | null {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment.type === "thinking") {
      if (!segment.content.trim()) continue;
      const banner = thinkingBannerPhrase(segment.content);
      const tail = banner
        ? activityPreview(banner, LINE_MAX_CHARS)
        : thoughtTail(segment.content);
      if (tail) return zh ? `正在思考:「${tail}」` : `Thinking: "${tail}"`;
      continue;
    }
    if (segment.type === "tool_round") {
      const calls = flattenToolBlocks(segment.toolBlocks);
      const call = calls[calls.length - 1];
      if (!call) continue;
      const presentation = toolCallPresentation(call, zh ? "zh" : "en");
      const detail = presentation.target
        ? `${presentation.name} · ${activityPreview(presentation.target, 80)}`
        : presentation.name;
      const verb = call.status === "running"
        ? zh ? "正在调用" : "Calling"
        : zh ? "最近调用" : "Last call";
      return zh ? `${verb}:「${detail}」` : `${verb}: "${detail}"`;
    }
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
  // A folded row previews the newest thought only. Error output belongs to the
  // tool row that produced it: promoting it here turns the folded summary into
  // an alert the reader never asked to reopen.
  const foldedPreview = processPreview;
  // Only a live row streams: history keeps the call-count summary, which is the
  // part that stays true once the turn has stopped thinking.
  const activityLine = isWorking ? latestActivityLine(segments, locale === "zh") : null;
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
              className="max-w-full truncate rounded-md border border-default-200 px-2 py-1 text-[10px] text-primary hover:bg-default-100"
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
          className="flex items-center gap-2 rounded-md border border-warning/20 bg-warning/5 px-3 py-1.5 text-[10px] text-warning"
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
  // One row per record: a thought, or one call batch. A live turn shows the
  // newest rows in a fixed window; a finished turn lays the same rows out in
  // place, so completing a turn never rebuilds what the reader opened.
  const processRows: ActivityWindowRow[] = [];
  if (hasActivity && expanded) {
    segments.forEach((segment, index) => {
      if (index > lastActivity) return;
      const key = segmentKey(segment, index);
      if (segment.type === "tool_round") {
        const roundRows = toolRoundRows(segment.toolBlocks, {
          isStreaming: isWorking,
          rememberKey: rowKeyPrefix ? `${rowKeyPrefix}:${key}` : undefined,
        });
        roundRows.forEach((row) => {
          processRows.push({
            key: `${key}:${row.key}`,
            node: (
              <div className="session-flow-entry" data-process data-activity>
                {row.node}
              </div>
            ),
          });
        });
        return;
      }
      const activity = segment.type === "thinking";
      processRows.push({
        key,
        node: (
          <div
            className={activity ? "session-flow-entry" : "session-flow-entry session-answer-region"}
            data-process
            data-activity={activity || undefined}
          >
            {!activity && (
              <MessageSquare className="session-flow-comment-icon" size={16} aria-hidden="true" />
            )}
            {render(segment, index)}
          </div>
        ),
      });
    });
  }
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
          aria-controls={`${flowId}-process`}
          aria-label={activityLine ?? undefined}
          onClick={toggle}
        >
          {activityLine ? (
            <StreamingActivityLine text={activityLine} streaming={isWorking} />
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
      {!expanded && foldedPreview && <div className="session-process-preview">{foldedPreview}</div>}
      <div className="session-flow-content">
        {hasActivity && (
          <div
            id={`${flowId}-process`}
            className="session-process-window"
            data-process
            hidden={!expanded}
          >
            <VirtualActivityWindow rows={processRows} windowed={isWorking} />
          </div>
        )}
        {segments.map((segment, index) => {
          if (index <= lastActivity) return null;
          return (
            <div
              key={segmentKey(segment, index)}
              id={`${flowId}-${index}`}
              className="session-flow-entry session-answer-region"
              data-answer-start={hasActivity && index === lastActivity + 1 || undefined}
            >
              {render(segment, index)}
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
