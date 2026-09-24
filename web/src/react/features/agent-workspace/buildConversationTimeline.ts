import { visualizationReplyParts } from "./visualizationTranscript";
import { readSessionUserPrompt } from "./sessionMetadata";
import type { RuntimeContentPart } from "../../../lib/api/runtimeMedia";
import type {
  AgentInteraction,
  AgentRun,
  AgentRunStep,
  AgentRuntimeMessage,
  AgentSession,
  ToolCallRecord,
} from "../../../lib/api/agentRuntime";
import {
  buildInterleavedTurns,
  type InterleavedTurn,
  type TurnContentBlock,
} from "./buildInterleavedTurns";

export type ConversationTimelineEntry =
  | {
      id: string;
      kind: "error";
      createdAt: string;
      label: string;
      message: string;
      model: string | null;
    }
  | {
      id: string;
      kind: "interaction";
      createdAt: string;
      label: string;
      interaction: AgentInteraction;
      disabled?: boolean;
    }
  | {
      id: string;
      kind: "model_switch";
      createdAt: string;
      label: string;
      fromModel: string;
      toModel: string;
    }
  | {
      id: string;
      kind: "user";
      createdAt: string;
      label: string;
      contentParts?: RuntimeContentPart[];
      content: string;
      /** App-composed prompt scaffolding rather than something the user typed. */
      injected?: boolean;
    }
  | {
      id: string;
      kind: "agent";
      createdAt: string;
      label: string;
      turn: InterleavedTurn;
    }
  | {
      id: string;
      kind: "work_log";
      createdAt: string;
      label: string;
      turns: InterleavedTurn[];
      stats: WorkLogStats;
    };

export interface WorkLogStats {
  stepCount: number;
  toolCallCount: number;
  thinkingChars: number;
  elapsedMs: number;
}

/**
 * Fewest turns worth hiding behind a `工作用时` row.
 *
 * One, because a finished round collapses *all* of its intermediate process: a
 * single leftover step is still noise sitting between the prompt and the answer.
 */
export const WORK_LOG_MIN_TURNS = 1;

function truncate(text: string, max = 48): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function toTimestamp(value: string): number {
  return new Date(value).getTime();
}

export function isSessionPromptUserMessage(
  message: AgentRuntimeMessage,
): boolean {
  return (
    message.role === "user" && message.metadata?.source === "session_prompt"
  );
}

export function sessionUserInputEntryId(sessionId: string): string {
  return `user-input-${sessionId}`;
}

export function extractSessionUserInput(
  session: AgentSession | undefined,
): string | null {
  if (!session) return null;
  return readSessionUserPrompt(session.sessionMetadata);
}

function isTimelineUserMessage(message: AgentRuntimeMessage): boolean {
  return (
    message.role === "user" &&
    (message.content.trim() !== "" || Boolean(message.contentParts?.length)) &&
    !isSessionPromptUserMessage(message)
  );
}

export type UserMessageTimelineEntry = {
  id: string;
  createdAt: string;
  label: string;
  content: string;
  contentParts?: RuntimeContentPart[];
  /** True when the app composed this prompt for the model rather than the user
   *  typing it — the transcript shows those as a compact injection chip. */
  injected?: boolean;
};

/**
 * The goal prompt scaffolding always opens with the language directive, which
 * makes it recognisable even for messages stored before `messageSource`
 * existed. A hand-typed prompt would have to start with that exact heading.
 */
const INJECTED_PROMPT_MARKER = "## Language Output Directive";

export function isSystemInjectedMessage(message: AgentRuntimeMessage): boolean {
  if (message.role !== "user") return false;
  if (message.metadata?.source === "system_injection") return true;
  return message.content.trimStart().startsWith(INJECTED_PROMPT_MARKER);
}

function userTimelineEntry(
  message: AgentRuntimeMessage,
): UserMessageTimelineEntry {
  const injected = isSystemInjectedMessage(message);
  return {
    id: message.id,
    createdAt: message.createdAt,
    label: injected ? "已注入系统提示" : truncate(message.content),
    content: message.content,
    contentParts: message.contentParts,
    ...(injected ? { injected: true } : {}),
  };
}

export function buildUserMessageEntries(
  messages: AgentRuntimeMessage[],
  session?: AgentSession,
  includeInitialPrompt = true,
): UserMessageTimelineEntry[] {
  const fromMessages = messages
    .filter(isTimelineUserMessage)
    .sort((a, b) => toTimestamp(a.createdAt) - toTimestamp(b.createdAt))
    .map(userTimelineEntry);

  const userInput = extractSessionUserInput(session);
  if (!userInput || !session) return fromMessages;
  if (!includeInitialPrompt) return fromMessages;

  const alreadyShown = fromMessages.some(
    (entry) => entry.content.trim() === userInput,
  );
  if (alreadyShown) return fromMessages;

  const forkCreatedAt = (session.sessionMetadata?.fork as { sourceCreatedAt?: string } | undefined)?.sourceCreatedAt;
  const initial: UserMessageTimelineEntry = {
    id: sessionUserInputEntryId(session.id),
    createdAt: messages.find(isSessionPromptUserMessage)?.createdAt ?? forkCreatedAt ?? session.createdAt,
    label: truncate(userInput),
    content: userInput,
  };

  return [initial, ...fromMessages];
}

function agentEntry(
  turn: InterleavedTurn,
  step: AgentRunStep | undefined,
): ConversationTimelineEntry {
  let label = `Step ${turn.index}`;
  for (const block of turn.blocks) {
    if (block.type === "text" && block.content.trim()) {
      label = truncate(block.content);
      break;
    }
    if (block.type === "tool_call") {
      label = block.call.toolId;
      break;
    }
    if (block.type === "tool_call_group" && block.calls[0]) {
      label = block.calls[0].toolId;
      break;
    }
  }

  return {
    id: turn.stepId,
    kind: "agent",
    createdAt: step?.startedAt ?? turn.stepId,
    label,
    turn,
  };
}

interface TimelineItem {
  timestamp: number;
  entry: ConversationTimelineEntry;
}

/**
 * The transcript is a flat list. Entries keep their own timestamps so the list
 * stays sorted once a round is rewritten into a folded row plus its answer.
 */
type AgentTimelineItem = {
  timestamp: number;
  entry: Extract<ConversationTimelineEntry, { kind: "agent" }>;
};

function buildTimelineItems(
  steps: AgentRunStep[],
  agentTurns: InterleavedTurn[],
  userEntries: UserMessageTimelineEntry[],
): TimelineItem[] {
  const stepById = new Map(steps.map((step) => [step.id, step]));
  const items: TimelineItem[] = [];

  for (const user of userEntries) {
    items.push({
      timestamp: toTimestamp(user.createdAt),
      entry: { kind: "user", ...user },
    });
  }

  const modelSwitches = new Map<string, string>();
  let previousModel: string | null = null;
  for (const step of [...steps].sort(
    (a, b) => toTimestamp(a.startedAt) - toTimestamp(b.startedAt),
  )) {
    if (!step.model) continue;
    if (previousModel && previousModel !== step.model) {
      modelSwitches.set(step.id, previousModel);
    }
    previousModel = step.model;
  }

  for (const turn of agentTurns) {
    const step = stepById.get(turn.stepId);
    const fromModel = modelSwitches.get(turn.stepId);
    if (step?.model && fromModel) {
      items.push({
        timestamp: toTimestamp(step.startedAt),
        entry: {
          id: `model-switch-${step.id}`,
          kind: "model_switch",
          createdAt: step.startedAt,
          label: `${fromModel} → ${step.model}`,
          fromModel,
          toModel: step.model,
        },
      });
    }
    items.push({
      timestamp: step ? toTimestamp(step.startedAt) : 0,
      entry: agentEntry(turn, step),
    });
  }

  items.sort((a, b) => a.timestamp - b.timestamp);
  return items;
}

/**
 * Whether a Run has finished. Steps without a Run record are treated as
 * finished: a transcript with no run rows is history being read, not live work.
 *
 * An unfinished round keeps every step expanded so the reader can watch it run;
 * only a completed round folds its own process away.
 */
function isRunComplete(status: AgentRun["status"] | undefined): boolean {
  if (!status) return true;
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function turnToolCallCount(turn: InterleavedTurn): number {
  let count = 0;
  for (const block of turn.blocks) {
    if (block.type === "tool_call") count += 1;
    if (block.type === "tool_call_group") count += block.calls.length;
  }
  return count;
}

function turnThinkingChars(turn: InterleavedTurn): number {
  return turn.blocks.reduce(
    (total, block) =>
      block.type === "thinking" ? total + block.content.length : total,
    0,
  );
}

function workLogEntry(
  turns: InterleavedTurn[],
  stepById: Map<string, AgentRunStep>,
  anchorId: string,
): ConversationTimelineEntry {
  const first = stepById.get(turns[0].stepId);
  const last = stepById.get(turns[turns.length - 1].stepId);
  const startMs = first ? toTimestamp(first.startedAt) : 0;
  const endMs = last
    ? toTimestamp(last.completedAt ?? last.startedAt)
    : startMs;

  return {
    // Anchored to the first step so the id stays stable while the run grows.
    id: `work-log-${anchorId}`,
    kind: "work_log",
    createdAt: first?.startedAt ?? turns[0].stepId,
    label: `Work log · ${turns.length} steps`,
    turns,
    stats: {
      stepCount: turns.length,
      toolCallCount: turns.reduce(
        (total, turn) => total + turnToolCallCount(turn),
        0,
      ),
      thinkingChars: turns.reduce(
        (total, turn) => total + turnThinkingChars(turn),
        0,
      ),
      elapsedMs: Math.max(0, endMs - startMs),
    },
  };
}

/** Keep the entire completed reply (text → preview → text) outside the work log. */
function splitTurnAnswer(turn: InterleavedTurn): {
  process: TurnContentBlock[];
  answer: TurnContentBlock[];
} {
  const visualIndex = turn.blocks.findIndex(
    (block) => block.type === "visualization",
  );
  if (visualIndex >= 0) {
    let start = visualIndex;
    const visual = turn.blocks[visualIndex];
    const messageId = "messageId" in visual ? visual.messageId : undefined;
    while (start > 0) {
      const previous = turn.blocks[start - 1];
      if (
        !messageId ||
        !("messageId" in previous) ||
        previous.messageId !== messageId
      )
        break;
      start--;
    }
    return {
      process: turn.blocks.slice(0, start),
      answer: turn.blocks.slice(start),
    };
  }
  for (let i = turn.blocks.length - 1; i >= 0; i--) {
    const block = turn.blocks[i];
    if (block.type === "text" && block.content.trim())
      return { process: turn.blocks.slice(0, i), answer: turn.blocks.slice(i) };
  }
  return { process: turn.blocks, answer: [] };
}

function turnWithBlocks(
  turn: InterleavedTurn,
  blocks: TurnContentBlock[],
): InterleavedTurn {
  return { ...turn, blocks };
}

function foldSegment(
  segment: AgentTimelineItem[],
  stepById: Map<string, AgentRunStep>,
): TimelineItem[] {
  if (segment.length === 0) return [];
  const turns = segment.map((item) => item.entry.turn);
  if (turns.length < WORK_LOG_MIN_TURNS)
    return segment.map((item) => ({
      timestamp: item.timestamp,
      entry: item.entry,
    }));
  return [
    {
      timestamp: segment[0].timestamp,
      entry: workLogEntry(turns, stepById, segment[0].entry.id),
    },
  ];
}

/**
 * Fold one finished round into `工作用时 …` plus its answer.
 *
 * A round is everything the agent did between two user prompts. Once it has
 * finished, all of that process collapses into a single expandable row; only
 * the answer text stays in the transcript, followed by whatever the agent kept
 * doing afterwards (a goal continuation, for example) in its own row.
 */
function foldRound(
  round: AgentTimelineItem[],
  stepById: Map<string, AgentRunStep>,
): TimelineItem[] {
  // Each visual reply stays visible, even if a goal continues afterwards.
  const visualTurn = round.findIndex((item) =>
    item.entry.turn.blocks.some((block) => block.type === "visualization"),
  );
  if (visualTurn >= 0 && visualTurn < round.length - 1)
    return [
      ...foldRound(round.slice(0, visualTurn + 1), stepById),
      ...foldRound(round.slice(visualTurn + 1), stepById),
    ];
  let answerIndex = -1;
  for (let i = round.length - 1; i >= 0; i -= 1) {
    if (
      round[i].entry.turn.blocks.some(
        (block) =>
          block.type === "visualization" ||
          (block.type === "text" && block.content.trim() !== ""),
      )
    ) {
      answerIndex = i;
      break;
    }
  }

  if (answerIndex < 0) {
    return foldSegment(round, stepById);
  }

  const answerItem = round[answerIndex];
  const { process, answer } = splitTurnAnswer(answerItem.entry.turn);
  if (!answer.length) return foldSegment(round, stepById);

  const leading = round.slice(0, answerIndex);
  const trailing = round.slice(answerIndex + 1);

  const folded: TimelineItem[] = [];
  // The answer step's own reasoning and tool calls belong to the process row in
  // front of the answer, not behind it.
  const leadingSegment =
    process.length > 0
      ? [
          ...leading,
          {
            timestamp: answerItem.timestamp,
            entry: {
              ...answerItem.entry,
              turn: turnWithBlocks(answerItem.entry.turn, process),
            },
          },
        ]
      : leading;
  folded.push(...foldSegment(leadingSegment, stepById));
  folded.push({
    timestamp: answerItem.timestamp,
    entry: {
      ...answerItem.entry,
      // A distinct anchor: the same step id also names the folded process row.
      id: `${answerItem.entry.id}-answer`,
      label:
        truncate(
          answer
            .filter((block) => block.type === "text")
            .map((block) => block.content)
            .join(" "),
        ) || "交互预览",
      turn: turnWithBlocks(answerItem.entry.turn, answer),
    },
  });
  folded.push(...foldSegment(trailing, stepById));
  return folded;
}

/**
 * Collapse every finished round's intermediate process into one row.
 *
 * A long agent run spends most of its steps on think → tool → think loops that
 * produce no answer: the measured local session has 82 steps, 81 of them
 * process. Rendering one entry per step makes the transcript long and expensive
 * to lay out, and buries the answer under it. Folding keeps every user message
 * and every answer exactly where they were, with one expandable row in between
 * that still holds the full record.
 */
function foldCompletedRounds(
  items: TimelineItem[],
  stepById: Map<string, AgentRunStep>,
  runStatusByStepId: Map<string, AgentRun["status"] | undefined>,
  standaloneReplyIds: Set<string>,
): TimelineItem[] {
  const folded: TimelineItem[] = [];
  let index = 0;

  while (index < items.length) {
    const entry = items[index].entry;
    if (entry.kind !== "agent" || standaloneReplyIds.has(entry.id)) {
      folded.push(items[index]);
      index += 1;
      continue;
    }

    let end = index;
    while (
      end < items.length &&
      items[end].entry.kind === "agent" &&
      !standaloneReplyIds.has(items[end].entry.id)
    ) end += 1;

    const round = items.slice(index, end) as AgentTimelineItem[];
    const complete = round.every((item) =>
      isRunComplete(runStatusByStepId.get(item.entry.turn.stepId)),
    );
    if (!complete) {
      for (const item of round)
        folded.push({ timestamp: item.timestamp, entry: item.entry });
    } else {
      folded.push(...foldRound(round, stepById));
    }
    index = end;
  }

  return folded;
}

export function buildConversationTimeline(
  runs: AgentRun[],
  steps: AgentRunStep[],
  messages: AgentRuntimeMessage[],
  toolCalls: ToolCallRecord[],
  childSessions?: AgentSession[],
  options?: {
    excludeStepId?: string | null;
    session?: AgentSession;
    foldWorkRuns?: boolean;
    includeInitialPrompt?: boolean;
    interactions?: AgentInteraction[];
  },
): ConversationTimelineEntry[] {
  messages = options?.session
    ? messages.filter((message) => message.sessionId === options.session!.id)
    : messages;
  const filteredSteps = options?.excludeStepId
    ? steps.filter((step) => step.id !== options.excludeStepId)
    : steps;

  const failedRunIds = new Set(
    runs.filter((run) => run.status === "failed").map((run) => run.id),
  );
  const failedStepIds = new Set(
    filteredSteps
      .filter((step) => failedRunIds.has(step.runId))
      .map((step) => step.id),
  );
  const agentTurns = buildInterleavedTurns(
    filteredSteps,
    toolCalls,
    messages,
    childSessions,
  ).filter((turn) => !failedStepIds.has(turn.stepId) || turn.blocks.length > 0);
  const userEntries = buildUserMessageEntries(messages, options?.session, options?.includeInitialPrompt);

  const items = buildTimelineItems(filteredSteps, agentTurns, userEntries);
  // Completed replies with no surviving step still belong to their message, not a synthetic artifact event.
  const stepIds = new Set(steps.map((step) => step.id));
  const runIdsWithSteps = new Set(steps.map((step) => step.runId));
  const seenOrphans = new Set<string>();
  const standaloneReplyIds = new Set<string>();
  for (const message of messages) {
    if (
      message.role !== "assistant" ||
      message.metadata?.partial ||
      message.metadata?.type === "thinking" ||
      message.metadata?.kind === "thought" ||
      ["artifact_publisher", "artifact_request", "artifact_job"].includes(String(message.metadata?.source)) ||
      (message.stepId && stepIds.has(message.stepId)) ||
      (!message.stepId &&
        message.runId &&
        runIdsWithSteps.has(message.runId)) ||
      seenOrphans.has(message.id)
    )
      continue;
    const isForkReply = typeof message.metadata?.forkedFromMessageId === "string";
    const blocks: TurnContentBlock[] = visualizationReplyParts(message);
    if (!isForkReply && !blocks.some((block) => block.type === "visualization")) continue;
    if (isForkReply && message.contentParts?.some((part) => part.type !== "text")) {
      blocks.unshift({ type: "media", parts: message.contentParts, messageId: message.id });
    }
    if (!blocks.length) continue;
    seenOrphans.add(message.id);
    // Forks intentionally have no execution steps. Their copied replies are
    // transcript rows, so never fold them into a fabricated work log.
    if (isForkReply) standaloneReplyIds.add(`reply-${message.id}`);
    items.push({
      timestamp: toTimestamp(message.createdAt),
      entry: {
        id: `reply-${message.id}`,
        kind: "agent",
        createdAt: message.createdAt,
        label: truncate(message.content) || (isForkReply ? "助手回复" : "交互预览"),
        turn: {
          stepId: `reply-${message.id}`,
          index: 0,
          status: "completed",
          duration: null,
          blocks,
        },
      },
    });
  }
  items.sort((a, b) => a.timestamp - b.timestamp);
  // A failed run has no assistant reply in storage. Keep its error as a durable,
  // unfolded row, independent of the session's status after a later successful run.
  for (const run of runs) {
    if (
      run.status !== "failed" ||
      (options?.session && run.sessionId !== options.session.id)
    )
      continue;
    const createdAt = run.completedAt ?? run.startedAt;
    const message = run.stopReason?.trim() || "Request failed";
    const row: TimelineItem = {
      timestamp: toTimestamp(createdAt),
      entry: {
        id: `run-error-${run.id}`,
        kind: "error",
        createdAt,
        label: message,
        message,
        model: run.model,
      },
    };
    const next = items.findIndex((item) => item.timestamp > row.timestamp);
    items.splice(next < 0 ? items.length : next, 0, row);
  }
  // Interactions are first-class transcript rows, so folding can never hide a question
  // or separate its eventual answer from the original request.
  for (const interaction of options?.interactions ?? []) {
    if (options?.session && interaction.sessionId !== options.session.id)
      continue;
    const anchor = items.findIndex(
      (item) =>
        item.entry.kind === "agent" &&
        item.entry.turn.stepId === interaction.stepId,
    );
    const row: TimelineItem = {
      timestamp: toTimestamp(interaction.createdAt),
      entry: {
        id: `interaction-${interaction.id}`,
        kind: "interaction",
        createdAt: interaction.createdAt,
        label: interaction.request.title,
        interaction,
        disabled: options?.session?.status === "cancelled",
      },
    };
    if (anchor >= 0) items.splice(anchor + 1, 0, row);
    else {
      const next = items.findIndex((item) => item.timestamp > row.timestamp);
      items.splice(next < 0 ? items.length : next, 0, row);
    }
  }
  if (options?.foldWorkRuns === false) return items.map((item) => item.entry);

  const stepById = new Map(filteredSteps.map((step) => [step.id, step]));
  const runStatusById = new Map(runs.map((run) => [run.id, run.status]));
  const runStatusByStepId = new Map(
    filteredSteps.map((step) => [step.id, runStatusById.get(step.runId)]),
  );

  return foldCompletedRounds(items, stepById, runStatusByStepId, standaloneReplyIds).map(
    (item) => item.entry,
  );
}

export function sessionEntryDomId(entryId: string): string {
  return `session-entry-${entryId}`;
}
