import { LIVE_PREVIEW_OMISSION } from "../streamingLiveBlocks";
import type {
  AgentRunStep,
  AgentRuntimeMessage,
  ToolCallRecord,
} from "../../../adapters/transport/agentRuntime";
import type { TurnContentBlock } from "../buildInterleavedTurns";

/**
 * A completed live turn snapshot. The run id is recorded while the snapshot is
 * created — the `steps` collection can drop a settled step before the persisted
 * messages land, and the snapshot must still be attributable to its run.
 */
export interface CompletedLiveStep {
  stepId: string;
  stepIndex: number;
  runId?: string;
  /** Preserve the turn's position while its history page is still loading. */
  startedAt?: string;
  /**
   * The live stream had already painted rows for this step.
   *
   * A bridge may replay `step_started` for a step that is still streaming; that
   * re-announcement parks the painted content here. Only a step that the
   * transcript actually showed may be parked, so a stream that never mounted
   * cannot pull a persisted step back out of the static timeline.
   */
  rendered?: boolean;
  blocks: readonly TurnContentBlock[];
}

export type LiveStepSnapshot = Pick<
  CompletedLiveStep,
  "stepId" | "stepIndex" | "runId" | "rendered"
> & { blocks: readonly TurnContentBlock[] };

function isThinkingMessage(message: AgentRuntimeMessage): boolean {
  return (
    message.metadata?.type === "thinking" ||
    message.metadata?.kind === "thought" ||
    (typeof message.metadata?.thought === "string" &&
      Boolean(message.metadata.thought.trim()))
  );
}

function isAnswerMessage(message: AgentRuntimeMessage): boolean {
  return (
    message.role === "assistant" &&
    message.metadata?.type !== "thinking" &&
    message.metadata?.kind !== "thought"
  );
}

function withoutOmission(content: string): string {
  const text = content.trim();
  return text.startsWith(LIVE_PREVIEW_OMISSION)
    ? text.slice(LIVE_PREVIEW_OMISSION.length).trim()
    : text;
}

/**
 * Live text may start from a preview that omits earlier prose. A snapshot whose
 * text cannot be found in the persisted answer is not a duplicate; it is the
 * only copy of that content and must stay mounted.
 */
function isShown(part: string, shown: string): boolean {
  if (shown.includes(part)) return true;
  if (part.length < 8) return false;
  // Allow the persisted answer to be a strict suffix of what is on screen:
  // trimming above can cut the preview marker in the middle of a sentence.
  return shown.trimEnd() === part.trimEnd();
}

/**
 * A streamed prefix of the persisted answer is already shown.
 *
 * The live text is normally shorter than the stored message: it is compared
 * while it is still being written. `isShown` is one-directional on purpose —
 * the reverse check below would retire a snapshot every time the model streams
 * a token, because that token is not in the (older) persisted copy yet.
 */
function isPrefixOf(part: string, shown: string): boolean {
  if (shown.includes(part)) return true;
  if (part.length < 8) return false;
  return shown.trimStart().startsWith(part.trimStart());
}

function persistedText(
  messages: readonly AgentRuntimeMessage[],
  stepId: string,
  runId?: string,
): string {
  return messages
    .filter(
      (message) =>
        isAnswerMessage(message) &&
        (message.stepId === stepId ||
          (!message.stepId && Boolean(runId) && message.runId === runId)),
    )
    .map((message) => message.content)
    .join("\n");
}

function persistedThinking(
  messages: readonly AgentRuntimeMessage[],
  stepId: string,
): string {
  return messages
    .filter((message) => message.stepId === stepId && isThinkingMessage(message))
    .map((message) =>
      message.metadata?.type === "thinking" || message.metadata?.kind === "thought"
        ? message.content
        : String(message.metadata?.thought ?? ""),
    )
    .join("\n");
}

function hasOmittedContent(
  messages: readonly AgentRuntimeMessage[],
  stepId: string,
  runId?: string,
): boolean {
  return messages.some(
    (message) =>
      Boolean(message.historyProjection?.omittedFields.includes("content")) &&
      (message.stepId === stepId ||
        (!message.stepId && Boolean(runId) && message.runId === runId)),
  );
}

function snapshotText(blocks: readonly TurnContentBlock[]): string[] {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => withoutOmission(block.content))
    .filter(Boolean);
}

function snapshotThinking(blocks: readonly TurnContentBlock[]): string {
  return blocks
    .filter((block) => block.type === "thinking")
    .map((block) => block.content.trim())
    .join("\n");
}

function snapshotToolIds(blocks: readonly TurnContentBlock[]): string[] {
  return blocks.flatMap((block) =>
    block.type === "tool_call"
      ? [block.call.id]
      : block.type === "tool_call_group"
        ? block.calls.map((call) => call.id)
        : [],
  );
}

/**
 * Whether the persisted transcript already shows this live snapshot.
 *
 * Comparing before/after persistence is what makes retiring a snapshot atomic:
 * the row is dropped in the same commit that renders the persisted message, so
 * the answer never appears twice and never briefly disappears.
 *
 * `toolCalls` is optional: incremental history pages only carry changed
 * entities, so tool call verification must fall back to "the step is settled"
 * instead of assuming the tool call is missing.
 */
export function isLiveStepPersisted(
  snapshot: LiveStepSnapshot,
  steps: readonly AgentRunStep[],
  messages: readonly AgentRuntimeMessage[],
  toolCalls?: readonly ToolCallRecord[],
): boolean {
  const step = steps.find((item) => item.id === snapshot.stepId);
  if (!step) return false;
  const runId = snapshot.runId ?? step.runId;
  // A message whose content was omitted for projection tells us nothing about
  // whether the visible text already matches; keep the snapshot until the full
  // content is hydrated rather than trading a duplicate for a blank answer.
  if (hasOmittedContent(messages, snapshot.stepId, runId)) return false;
  const text = snapshotText(snapshot.blocks);
  if (text.length > 0) {
    const shown = persistedText(messages, snapshot.stepId, runId);
    return text.every((part) => isPrefixOf(part, shown));
  }
  const toolIds = snapshotToolIds(snapshot.blocks);
  // A step that produced tool calls closes on those calls. Reasoning is often
  // persisted without a thinking record, so those rows are verified by their
  // call ids instead of forcing a text comparison that can never match.
  if (toolCalls && toolIds.length > 0)
    return toolIds.every((id) => toolCalls.some((call) => call.id === id));
  const thinking = snapshotThinking(snapshot.blocks);
  if (thinking) {
    // A persisted thinking message always renders its reasoning block, so the
    // block is the unit of comparison rather than the raw text.
    const shownThinking = persistedThinking(messages, snapshot.stepId);
    if (shownThinking.trim().length === 0) return false;
    return snapshot.blocks
      .filter((block) => block.type === "thinking")
      .every((block) => isShown(block.content.trim(), shownThinking));
  }
  return true;
}

/**
 * Re-anchor snapshots whose run id was unknown at snapshot time. Settled steps
 * may be missing from the incremental page, so this runs against the merged
 * (cached + changed) transcript after every refresh.
 */
export function attachSnapshotRunIds(
  snapshots: readonly CompletedLiveStep[],
  steps: readonly AgentRunStep[],
  runs: readonly { id: string }[],
  activeRunId?: string | null,
): CompletedLiveStep[] {
  if (snapshots.length === 0) return snapshots as CompletedLiveStep[];
  if (snapshots.every((snapshot) => snapshot.runId))
    return snapshots as CompletedLiveStep[];
  const runIds = new Set(runs.map((run) => run.id));
  let changed = false;
  const next = snapshots.map((snapshot) => {
    if (snapshot.runId) return snapshot;
    const step = steps.find((item) => item.id === snapshot.stepId);
    // Only an identity the merged transcript knows can rejoin the answer; a
    // guessed run id would retire the snapshot for the wrong message.
    const runId = step?.runId ?? activeRunId ?? undefined;
    if (!runId || !runIds.has(runId)) return snapshot;
    changed = true;
    return { ...snapshot, runId };
  });
  return changed ? next : (snapshots as CompletedLiveStep[]);
}

/** Drop snapshots the persisted transcript already renders. */
export function retirePersistedSnapshots(
  snapshots: readonly CompletedLiveStep[],
  steps: readonly AgentRunStep[],
  messages: readonly AgentRuntimeMessage[],
  toolCalls?: readonly ToolCallRecord[],
): CompletedLiveStep[] {
  if (snapshots.length === 0) return snapshots as CompletedLiveStep[];
  const remaining = snapshots.filter(
    (snapshot) => !isLiveStepPersisted(snapshot, steps, messages, toolCalls),
  );
  return remaining.length === snapshots.length
    ? (snapshots as CompletedLiveStep[])
    : remaining;
}
