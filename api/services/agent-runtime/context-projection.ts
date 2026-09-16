import { resolveContextInputOwners } from "./context-input-boundaries.js";
import { createHash } from "node:crypto";
import { runtimeTransaction } from "./runtime-transaction.js";
import {
  readContextEpochState,
  sessionContextBoundary,
  sentContextRequests,
  contextGrowthP95,
  type ContextEpochState,
} from "./context-epoch-store.js";
import {
  resolveContextCompactionPolicy,
  contextWatermarks,
  evaluateContextCompaction,
  type ContextWatermarks,
  type ContextCompactionDecision,
} from "./context-compaction-policy.js";
import {
  buildContextMemorySegment,
  assembleContextMemory,
  type ContextMemorySegment,
  type ContextMemorySnapshot,
} from "./context-memory.js";
import { initialSessionMessageProjection } from "./session-user-request.js";
import * as z from "zod/v4";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { RegisteredTool } from "./contracts.js";
import type { LoopToolSet } from "./loop-ai-tools.js";
import { agentRuntimeStore as store } from "./session-store.js";
import { workStore } from "./work-store.js";
import {
  buildLoopModelMessages,
  createLoopHistoryReader,
} from "./loop-model-messages.js";
import { countMessagesTokens, countTokens } from "./context-tokenizer.js";
import { AgentValidationError } from "./runtime-errors.js";
import { nowIso } from "./runtime-ids.js";

export interface ContextProjectionInput {
  sessionId: string;
  toolSet: LoopToolSet;
  contextLimit: number;
  outputReserve: number;
  systemTokens: number;
  model?: string;
  currentStepId?: string;
  configurationFingerprint?: string;
}

/** Shared empty result so the hot projection path never allocates one. */
const EMPTY_ID_SET: Set<string> = new Set();
export interface ContextCompactionDiagnostic {
  version: 1;
  epoch: number;
  action: string;
  reason: string;
  compacted: boolean;
  originalTokens: number;
  projectedTokens: number;
  reclaimedTokens: number;
  stableRequests: number;
  preparedThroughStepId: string | null;
  throughStepId: string | null;
  configurationChanged: boolean;
  watermarks: ContextWatermarks;
  economics: ContextCompactionDecision["economics"];
}

export function projectWorkContext(input: ContextProjectionInput): {
  messages: ModelMessage[];
  compacted: boolean;
  originalTokens: number;
  tokens: number;
  compaction?: ContextCompactionDiagnostic;
} {
  const session = store.getSession(input.sessionId);
  const work = workStore.current(input.sessionId);
  const initialUserMessage = initialSessionMessageProjection(session);
  // One read-only snapshot per request; the candidate loop only reads history.
  const history = createLoopHistoryReader(store, input.sessionId);
  const count = (messages: ModelMessage[]) =>
    countMessagesTokens(messages as never, input.model) + input.systemTokens;
  if (!work) {
    const messages = buildLoopModelMessages(
      store,
      input.sessionId,
      input.toolSet,
      {
        initialUserMessage,
        currentStepId: input.currentStepId,
        snapshot: history,
      },
    );
    const tokens = count(messages);
    if (tokens > input.contextLimit - input.outputReserve)
      throw new AgentValidationError(
        "context_blocked: required context exceeds the model window.",
      );
    return {
      messages,
      compacted: false,
      originalTokens: tokens,
      tokens,
    };
  }
  const boundaryState = sessionContextBoundary(input.sessionId, history);
  const { steps, boundary } = boundaryState;
  const policy = resolveContextCompactionPolicy(
    session.sessionMetadata?.contextCompactionPolicy,
  );
  const epochState = readContextEpochState(
    session.sessionMetadata?.contextCompactionState,
  );
  const sent = sentContextRequests(steps, input.currentStepId);
  const checkpointEpoch = boundaryState.checkpointWork?.checkpoint?.epoch;
  if (
    typeof checkpointEpoch === "number" &&
    Number.isSafeInteger(checkpointEpoch) &&
    checkpointEpoch > epochState.epoch
  ) {
    // A legacy/restored session may retain its Work checkpoint but not its new
    // scheduling counters. Recover identity; do not invent a warm-cache interval.
    epochState.epoch = checkpointEpoch;
    epochState.committedRequestCount = sent.length;
    delete epochState.draft;
  }

  const configurationChanged = Boolean(
    input.configurationFingerprint &&
    epochState.configurationFingerprint &&
    input.configurationFingerprint !== epochState.configurationFingerprint,
  );
  const nextState: ContextEpochState = {
    ...epochState,
    ...(input.configurationFingerprint
      ? { configurationFingerprint: input.configurationFingerprint }
      : {}),
    ...(configurationChanged
      ? { committedRequestCount: sent.length, draft: undefined }
      : {}),
  };
  const stableRequests = Math.max(
    0,
    sent.length - nextState.committedRequestCount,
  );
  const watermarks = contextWatermarks(
    policy,
    input.contextLimit,
    input.outputReserve,
    contextGrowthP95(sent, epochState.epoch),
  );
  const users = history
    .listMessages()
    .filter((message) => message.role === "user");
  // Memoized per candidate snapshot to avoid rescanning memory entries.
  const summarizedByMemory = new WeakMap<ContextMemorySnapshot, Set<string>>();
  const summarizedInputIds = (memory?: ContextMemorySnapshot) => {
    if (!memory) return EMPTY_ID_SET;
    const cached = summarizedByMemory.get(memory);
    if (cached) return cached;
    const covered = new Set<string>();
    for (const entry of memory.entries)
      if (
        entry.required &&
        entry.source.kind === "message" &&
        entry.source.field === "content"
      )
        covered.add(`${entry.source.id}\u0000${entry.text}`);
    const ids = new Set(
      users
        .filter(
          (message) =>
            !message.contentParts?.some((part) => part.type !== "text") &&
            covered.has(`${message.id}\u0000${message.content}`),
        )
        .map((message) => message.id),
    );
    summarizedByMemory.set(memory, ids);
    return ids;
  };
  // Cuts repeat across candidates; build each excluded-step set once.
  const excludedByThrough = new Map<number, Set<string>>();
  const excludedThrough = (through: number) => {
    const cached = excludedByThrough.get(through);
    if (cached) return cached;
    const excluded = new Set(
      steps.slice(0, through + 1).map((step) => step.id),
    );
    excludedByThrough.set(through, excluded);
    return excluded;
  };
  const build = (
    through = boundary,
    summary = boundaryState.summary,
    memory = boundaryState.memory,
  ) =>
    buildLoopModelMessages(store, input.sessionId, input.toolSet, {
      snapshot: history,
      excludedStepIds: excludedThrough(through),
      compactionSummary: summary,
      summarizedInputIds: summarizedInputIds(memory),
      initialUserMessage,
      currentStepId: input.currentStepId,
    });
  const messages = build();
  const originalTokens = count(messages);
  const evaluate = (candidateTokens?: number) =>
    evaluateContextCompaction({
      policy,
      watermarks,
      currentTokens: originalTokens,
      candidateTokens,
      stableRequests,
      stablePrefixTokens: input.systemTokens,
    });
  let decision = evaluate();
  let preparedThroughStepId: string | null = null;
  const diagnostic = (
    projectedTokens = originalTokens,
    compacted = false,
    throughStepId: string | null = steps[boundary]?.id ?? null,
  ): ContextCompactionDiagnostic => ({
    version: 1,
    epoch: nextState.epoch,
    action: decision.action,
    reason: decision.reason,
    compacted,
    originalTokens,
    projectedTokens,
    reclaimedTokens: originalTokens - projectedTokens,
    stableRequests,
    preparedThroughStepId,
    throughStepId,
    configurationChanged,
    watermarks,
    economics: decision.economics,
  });
  const finishUnchanged = () => {
    if (originalTokens > watermarks.hard)
      throw new AgentValidationError(
        `context_blocked: ${decision.reason}; required intact context cannot fit.`,
      );
    store.updateSessionMetadata(input.sessionId, {
      contextCompactionState: nextState,
    });
    return {
      messages,
      compacted: false,
      originalTokens,
      tokens: originalTokens,
      compaction: diagnostic(),
    };
  };
  if (originalTokens < watermarks.prepare) return finishUnchanged();
  // Preparation is not a per-turn summarizer. Keep an existing invisible draft
  // until commit pressure; sources are revalidated below before any activation.
  if (
    originalTokens < watermarks.high &&
    nextState.draft &&
    !configurationChanged &&
    nextState.draft.fromStepId === (steps[boundary]?.id ?? null)
  ) {
    preparedThroughStepId = nextState.draft.throughStepId;
    return finishUnchanged();
  }

  const pinned = new Set(
    Array.isArray(session.sessionMetadata?.contextPinnedStepIds)
      ? session.sessionMetadata.contextPinnedStepIds.filter(
          (id): id is string => typeof id === "string",
        )
      : [],
  );
  const allCalls = history.listToolCalls();
  const byStep = new Map<string, typeof allCalls>();
  for (const call of allCalls) {
    if (!call.stepId) continue;
    const bucket = byStep.get(call.stepId);
    if (bucket) bucket.push(call);
    else byStep.set(call.stepId, [call]);
  }

  const runs = history.listRuns();
  const triggers = new Map(
    runs.map((run) => [run.id, run.triggerMessageId]),
  );
  const stepsByRun = new Map<string, typeof steps>();
  for (const step of steps) {
    const bucket = stepsByRun.get(step.runId);
    if (bucket) bucket.push(step);
    else stepsByRun.set(step.runId, [step]);
  }
  const queuedByRun = new Map<string, typeof users>();
  for (const message of users) {
    if (!message.runId || message.metadata.source !== "input_queue") continue;
    const bucket = queuedByRun.get(message.runId);
    if (bucket) bucket.push(message);
    else queuedByRun.set(message.runId, [message]);
  }
  const queueOwners = new Map<
    string,
    { stepId: string; placement: "before" | "after" }
  >();
  for (const run of runs) {
    const owned = resolveContextInputOwners(
      stepsByRun.get(run.id) ?? [],
      queuedByRun.get(run.id) ?? [],
    );
    for (const [id, owner] of owned) queueOwners.set(id, owner);
  }
  const firstSteps = new Map<string, string>();
  for (const step of steps)
    if (!firstSteps.has(step.runId)) firstSteps.set(step.runId, step.id);
  const segments: ContextMemorySegment[] = [];
  const indices: number[] = [];
  for (
    let index = boundary + 1;
    index < steps.length - policy.keepRecentSteps;
    index++
  ) {
    const step = steps[index];
    const calls = byStep.get(step.id) ?? [];
    if (
      step.id === input.currentStepId ||
      pinned.has(step.id) ||
      !["completed", "failed", "interrupted"].includes(step.status) ||
      calls.some((call) =>
        ["pending", "running", "waiting_permission"].includes(call.status),
      )
    )
      break;
    const ownedMessages = users.filter(
      (message) =>
        (firstSteps.get(step.runId) === step.id &&
          message.id === triggers.get(step.runId)) ||
        queueOwners.get(message.id)?.stepId === step.id,
    );
    const parts = history.listRunParts(step.id);
    const sourceFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          step: {
            id: step.id,
            index: step.index,
            startedAt: step.startedAt,
            status: step.status,
            completedAt: step.completedAt,
          },
          parts: parts
            .filter((part) => part.kind === "text" || part.kind === "error")
            .map((part) => [part.id, part.kind, part.sequence, part.content]),
          calls: calls.map((call) => [
            call.id,
            call.toolId,
            call.status,
            call.endedAt,
            call.outputRef,
            call.outputSummary,
            call.error,
            call.contentParts,
          ]),
          messages: ownedMessages.map((message) => [
            message.id,
            message.content,
            message.contentParts,
            message.createdAt,
            queueOwners.get(message.id)?.placement ?? "before",
          ]),
          receipts:
            step.metadata.contextProjectionVersion === 2
              ? step.metadata.toolContextReceipts
              : undefined,
        }),
      )
      .digest("hex");
    const cached = step.metadata.contextMemorySegment as
      | ContextMemorySegment
      | undefined;
    const reusable =
      step.metadata.contextMemorySourceFingerprint === sourceFingerprint &&
      cached?.version === 1 &&
      cached.stepId === step.id &&
      Array.isArray(cached.entries);
    const segment = reusable
      ? cached
      : buildContextMemorySegment({
          step,
          parts,
          calls,
          messages: ownedMessages,
          ownedMessageIds: ownedMessages.map((message) => message.id),
          messagePlacements: Object.fromEntries(
            ownedMessages.map((message) => [
              message.id,
              queueOwners.get(message.id)?.placement ?? "before",
            ]),
          ),
        });
    if (!reusable)
      store.updateRunStep(step.id, {
        metadata: {
          ...step.metadata,
          contextMemorySegment: segment,
          contextMemorySourceFingerprint: sourceFingerprint,
        },
      });
    segments.push(segment);
    indices.push(index);
  }
  if (!segments.length) {
    decision = {
      ...decision,
      action: originalTokens > watermarks.hard ? "blocked" : "keep",
      reason: "no-complete-unpinned-prefix",
    };
    return finishUnchanged();
  }

  type Candidate = {
    through: number;
    memory: ContextMemorySnapshot;
    summary: string;
    tokens: number;
    messages: ModelMessage[];
    segments: ContextMemorySegment[];
  };
  let candidate: Candidate | undefined;
  let invalidReason: string | undefined;
  // Batch at complete-step boundaries; do not chase the threshold one message at a time.
  const cuts = indices
    .map((_, index) => index + 1)
    .filter((n) => n % 8 === 0 || n === indices.length);
  for (const size of cuts) {
    const selected = segments.slice(0, size);
    const through = indices[size - 1];
    const locator = `Full memory index: context.read ${JSON.stringify({ kind: "checkpoint", id: steps[through].id })}`;
    const memoryBudget = Math.max(
      0,
      Math.min(
        policy.memoryTokenBudget,
        Math.max(128, watermarks.low - input.systemTokens),
      ) -
        countTokens(locator, input.model) -
        8,
    );
    const assembled = assembleContextMemory({
      segments: selected,
      previous: boundaryState.memory,
      ...(!boundaryState.memory && boundaryState.summary && steps[boundary]
        ? {
            legacy: {
              summary: boundaryState.summary,
              stepId: steps[boundary].id,
            },
          }
        : {}),
      epoch: epochState.epoch + 1,
      tokenBudget: memoryBudget,
      countTokens: (text) => countTokens(text, input.model),
    });
    if (!assembled.valid) {
      invalidReason = assembled.errors.join("; ");
      continue;
    }
    const summary = `${assembled.summary}\n${locator}`;
    const projected = build(through, summary, assembled.snapshot);
    const tokens = count(projected);
    if (!candidate || tokens < candidate.tokens)
      candidate = {
        through,
        memory: assembled.snapshot,
        summary,
        messages: projected,
        tokens,
        segments: selected,
      };
    if (tokens <= watermarks.low) break;
  }
  if (!candidate) {
    decision = {
      ...decision,
      action: originalTokens > watermarks.hard ? "blocked" : "keep",
      reason: `memory-validation-failed: ${invalidReason ?? "no-valid-candidate"}`,
    };
    return finishUnchanged();
  }
  preparedThroughStepId = steps[candidate.through].id;
  const sourceFingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        steps[boundary]?.id ?? null,
        candidate.segments.map((segment) => segment.fingerprint),
        candidate.summary,
      ]),
    )
    .digest("hex");
  const priorDraft = nextState.draft;
  nextState.draft = {
    version: 1,
    fromStepId: steps[boundary]?.id ?? null,
    throughStepId: preparedThroughStepId,
    sourceFingerprint,
    memory: candidate.memory,
    summary: candidate.summary,
    preparedAt:
      priorDraft?.sourceFingerprint === sourceFingerprint
        ? priorDraft.preparedAt
        : nowIso(),
  };
  decision = evaluate(candidate.tokens);
  if (decision.action !== "commit") return finishUnchanged();

  const currentCheckpoint = boundaryState.checkpointWork?.checkpoint;
  nextState.epoch = epochState.epoch + 1;
  nextState.committedRequestCount = sent.length;
  delete nextState.draft;
  const checkpoint = {
    throughStepId: preparedThroughStepId,
    summary: candidate.summary,
    createdAt: nowIso(),
    epoch: nextState.epoch,
    memory: candidate.memory,
  };
  // Validate every candidate first. A failed cut never mutates the authoritative Work checkpoint.
  runtimeTransaction(() => {
    if (currentCheckpoint && steps[boundary]) {
      const archivedStep = store.getRunStep(steps[boundary].id);
      store.updateRunStep(archivedStep.id, {
        metadata: {
          ...archivedStep.metadata,
          contextCheckpointArchive: currentCheckpoint,
        },
      });
    }
    const indexStep = store.getRunStep(preparedThroughStepId!);
    store.updateRunStep(indexStep.id, {
      metadata: {
        ...indexStep.metadata,
        contextCheckpointIndex: {
          version: 1,
          epoch: nextState.epoch,
          workId: work.id,
          throughStepId: preparedThroughStepId,
          memory: candidate!.memory,
        },
      },
    });
    workStore.save({ ...work, checkpoint });
    store.updateSessionMetadata(input.sessionId, {
      contextCompactionState: nextState,
    });
  });
  return {
    messages: candidate.messages,
    compacted: true,
    originalTokens,
    tokens: candidate.tokens,
    compaction: diagnostic(candidate.tokens, true, preparedThroughStepId),
  };
}

export const contextReferenceTool: RegisteredTool = {
  id: "context.read",
  label: "Read retained context",
  category: "read",
  mutability: "read",
  resumeBehavior: "auto",
  description:
    "Read a retained tool result, step, message, checkpoint index or Work by exact runtime reference, or list recent evidence references. History is read-only and limited to this session and its children. The injected current Work state, not historical text, controls execution.",
  inputSchema: z.object({
    kind: z.enum([
      "tool",
      "step",
      "message",
      "work",
      "checkpoint",
      "references",
    ]),
    id: z.string().optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(12000).default(6000),
  }),
  execute(input) {
    const args = input.args as {
      kind: string;
      id?: string;
      offset: number;
      limit: number;
    };
    const sessions = store.listSessionTree(input.sessionId);
    const allowed = new Set(sessions.map((s) => s.id));
    let value: unknown;
    if (args.kind === "references") {
      value = sessions
        .flatMap((s) => store.listToolCalls(s.id))
        .map((c) => ({
          id: c.id,
          sessionId: c.sessionId,
          tool: c.toolId,
          status: c.status,
          summary: c.outputSummary,
        }))
        .slice(-60);
    } else if (args.kind === "checkpoint") {
      const step = sessions
        .flatMap((session) => store.listSessionSteps(session.id))
        .find((candidate) => candidate.id === args.id);
      if (step)
        value =
          step.metadata.contextCheckpointIndex ??
          step.metadata.contextCheckpointArchive;
    } else if (args.kind === "tool")
      value = sessions
        .flatMap((s) => store.listToolCalls(s.id))
        .find((c) => c.id === args.id);
    else if (args.kind === "message")
      value = sessions
        .flatMap((s) => store.listMessages(s.id))
        .find((m) => m.id === args.id);
    else if (args.kind === "work" && args.id) {
      const work = workStore.get(args.id);
      value = work && allowed.has(work.sessionId) ? work : undefined;
    } else if (args.kind === "step") {
      const step = sessions
        .flatMap((s) => store.listSessionSteps(s.id))
        .find((s) => s.id === args.id);
      if (step) value = { step, parts: store.listRunParts(step.id) };
    }
    if (!value)
      throw new AgentValidationError(
        "Context reference does not exist in the accessible session tree.",
      );
    const text = JSON.stringify(value);
    return {
      result: {
        text: text.slice(args.offset, args.offset + args.limit),
        offset: args.offset,
        totalLength: text.length,
        hasMore: args.offset + args.limit < text.length,
      },
      displaySummary: `Read ${args.kind} ${args.id ?? "references"} (${Math.min(args.limit, Math.max(0, text.length - args.offset))} characters).`,
      artifacts: [],
    };
  },
};

/** Deduplication must use the actual projection boundary, not the old context-window percentage. */
export function evictedContextToolIds(sessionId: string): Set<string> {
  const work = workStore.current(sessionId);
  if (!work) return new Set();
  const history = createLoopHistoryReader(store, sessionId);
  const { steps, boundary } = sessionContextBoundary(sessionId, history);
  const excluded = new Set(steps.slice(0, boundary + 1).map((s) => s.id));
  return new Set(
    history
      .listToolCalls()
      .filter((c) => c.stepId && excluded.has(c.stepId))
      .map((c) => c.id),
  );
}
