import { messageArtifacts, messageArtifactRequest } from "./artifactTranscript";
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
): UserMessageTimelineEntry[] {
  const fromMessages = messages
    .filter(isTimelineUserMessage)
    .sort((a, b) => toTimestamp(a.createdAt) - toTimestamp(b.createdAt))
    .map(userTimelineEntry);

  const userInput = extractSessionUserInput(session);
  if (!userInput || !session) return fromMessages;

  const alreadyShown = fromMessages.some(
    (entry) => entry.content.trim() === userInput,
  );
  if (alreadyShown) return fromMessages;

  const initial: UserMessageTimelineEntry = {
    id: sessionUserInputEntryId(session.id),
    createdAt: session.createdAt,
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

  for (const turn of agentTurns) {
    const step = stepById.get(turn.stepId);
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

/**
 * Split a turn into the process that led to its answer and the answer itself.
 *
 * Only the trailing text block is the answer; anything the model wrote earlier
 * in the same step was still working out loud, so it folds with the rest.
 */
function splitTurnAnswer(turn: InterleavedTurn): {
  process: TurnContentBlock[];
  answer: { type: "text"; content: string } | null;
} {
  for (let i = turn.blocks.length - 1; i >= 0; i -= 1) {
    const block = turn.blocks[i];
    if (block.type !== "text" || !block.content.trim()) continue;
    return { process: turn.blocks.slice(0, i), answer: block };
  }
  return { process: turn.blocks, answer: null };
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
  let answerIndex = -1;
  for (let i = round.length - 1; i >= 0; i -= 1) {
    if (
      round[i].entry.turn.blocks.some(
        (block) => block.type === "text" && block.content.trim() !== "",
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
  if (!answer) return foldSegment(round, stepById);

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
      label: truncate(answer.content),
      turn: turnWithBlocks(answerItem.entry.turn, [answer]),
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
): TimelineItem[] {
  const folded: TimelineItem[] = [];
  let index = 0;

  while (index < items.length) {
    const entry = items[index].entry;
    if (entry.kind !== "agent") {
      folded.push(items[index]);
      index += 1;
      continue;
    }

    let end = index;
    while (end < items.length && items[end].entry.kind === "agent") end += 1;

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
    interactions?: AgentInteraction[];
  },
): ConversationTimelineEntry[] {
  const seenArtifacts = new Set<string>();
  const artifactEntries: ConversationTimelineEntry[] = messages.flatMap(
    (message) => {
      if (options?.session && message.sessionId !== options.session.id)
        return [];
      return messageArtifacts(message).flatMap((reference) => {
        if (seenArtifacts.has(reference.revisionId)) return [];
        seenArtifacts.add(reference.revisionId);
        return [
          {
            id: `artifact-${reference.revisionId}`,
            kind: "agent" as const,
            createdAt: message.createdAt,
            label: reference.title,
            turn: {
              stepId: `artifact-${reference.revisionId}`,
              index: 0,
              status: "completed",
              duration: null,
              blocks: [{ type: "artifact" as const, reference }],
            },
          },
        ];
      });
    },
  );
  for (const message of messages) {
    if (options?.session && message.sessionId !== options.session.id) continue;
    const reference = messageArtifactRequest(message);
    if (!reference || seenArtifacts.has(reference.requestId)) continue;
    seenArtifacts.add(reference.requestId);
    artifactEntries.push({
      id: `artifact-request-${reference.requestId}`,
      kind: "agent",
      createdAt: message.createdAt,
      label: reference.title,
      turn: {
        stepId: reference.requestId,
        index: 0,
        status: "completed",
        duration: null,
        blocks: [{ type: "artifact_request", reference }],
      },
    });
  }
  const withArtifacts = (entries: ConversationTimelineEntry[]) =>
    [...entries, ...artifactEntries].sort(
      (a, b) => toTimestamp(a.createdAt) - toTimestamp(b.createdAt),
    );
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
  const userEntries = buildUserMessageEntries(messages, options?.session);

  if (
    artifactEntries.length === 0 &&
    userEntries.length === 0 &&
    agentTurns.length === 0 &&
    failedRunIds.size === 0 &&
    !options?.interactions?.length
  )
    return [];

  const items = buildTimelineItems(filteredSteps, agentTurns, userEntries);
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
  if (options?.foldWorkRuns === false)
    return withArtifacts(items.map((item) => item.entry));

  const stepById = new Map(filteredSteps.map((step) => [step.id, step]));
  const runStatusById = new Map(runs.map((run) => [run.id, run.status]));
  const runStatusByStepId = new Map(
    filteredSteps.map((step) => [step.id, runStatusById.get(step.runId)]),
  );

  return withArtifacts(
    foldCompletedRounds(items, stepById, runStatusByStepId).map(
      (item) => item.entry,
    ),
  );
}

export function sessionEntryDomId(entryId: string): string {
  return `session-entry-${entryId}`;
}
