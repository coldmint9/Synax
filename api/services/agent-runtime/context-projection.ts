import { initialSessionMessageProjection } from "./session-user-request.js";
import * as z from "zod/v4";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { RegisteredTool } from "./contracts.js";
import type { LoopToolSet } from "./loop-ai-tools.js";
import { agentRuntimeStore as store } from "./session-store.js";
import { workStore } from "./work-store.js";
import { buildLoopModelMessages } from "./loop-model-messages.js";
import { countMessagesTokens } from "./context-tokenizer.js";
import { AgentValidationError } from "./runtime-errors.js";
import { nowIso } from "./runtime-ids.js";

// Conversation history and compression boundaries survive transitions between Works.
function sessionBoundary(sessionId: string) {
  const runs = store
    .listRuns(sessionId)
    .sort(
      (a, b) =>
        a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id),
    );
  const steps = runs.flatMap((r) => store.listRunSteps(r.id));
  let boundary = -1;
  let summary: string | null = null;
  const ids = new Set<string>();
  for (const r of runs)
    if (typeof r.metadata.workId === "string") ids.add(r.metadata.workId);
  for (const s of steps)
    if (typeof s.metadata.workId === "string") ids.add(s.metadata.workId);
  const current = workStore.current(sessionId);
  if (current) ids.add(current.id);
  for (const id of ids) {
    const w = workStore.get(id);
    if (w?.sessionId !== sessionId || !w.checkpoint) continue;
    const i = steps.findIndex((s) => s.id === w.checkpoint!.throughStepId);
    if (i < 0)
      throw new AgentValidationError(
        "context_blocked: the persisted context boundary is missing.",
      );
    if (i > boundary) {
      boundary = i;
      summary = w.checkpoint.summary;
    }
  }
  return { runs, steps, boundary, summary };
}

export function projectWorkContext(input: {
  sessionId: string;
  toolSet: LoopToolSet;
  contextLimit: number;
  outputReserve: number;
  systemTokens: number;
  model?: string;
  currentStepId?: string;
}): {
  messages: ModelMessage[];
  compacted: boolean;
  originalTokens: number;
  tokens: number;
} {
  const work = workStore.current(input.sessionId);
  const initialUserMessage = initialSessionMessageProjection(
    store.getSession(input.sessionId),
  );
  const count = (messages: ModelMessage[]) =>
    countMessagesTokens(messages as never, input.model) + input.systemTokens;
  if (!work) {
    const messages = buildLoopModelMessages(
      store,
      input.sessionId,
      input.toolSet,
      { initialUserMessage, currentStepId: input.currentStepId },
    );
    return {
      messages,
      compacted: false,
      originalTokens: count(messages),
      tokens: count(messages),
    };
  }
  const state = sessionBoundary(input.sessionId);
  const { steps } = state;
  let { boundary, summary: contextSummary } = state;
  const build = () =>
    buildLoopModelMessages(store, input.sessionId, input.toolSet, {
      excludedStepIds: new Set(steps.slice(0, boundary + 1).map((s) => s.id)),
      compactionSummary: contextSummary,
      initialUserMessage,
      currentStepId: input.currentStepId,
    });
  let messages = build();
  const originalTokens = count(messages);
  const hard = input.contextLimit - input.outputReserve;
  const soft = Math.min(64_000, Math.floor(hard / 2));
  let compacted = false;
  // A checkpoint replaces whole finished tool exchanges, never individual reasoning/signature fields.
  // Keep the newest finished exchange and the current in-flight step intact when possible.
  while (count(messages) > soft && boundary + 1 < steps.length - 2) {
    const candidate = steps[boundary + 1];
    const calls = store
      .listRunToolCalls(candidate.runId)
      .filter((c) => c.stepId === candidate.id);
    if (
      calls.some((c) =>
        ["running", "pending", "waiting_permission"].includes(c.status),
      ) ||
      candidate.status === "running"
    )
      break;
    const parts = store.listRunParts(candidate.id);
    const observations = parts
      .filter((p) => p.kind === "text")
      .map((p) => p.content.slice(0, 1200));
    const receipts = calls.map(
      (c) =>
        `${c.id} (${c.toolId}, ${c.status}): ${c.outputSummary?.slice(0, 600) ?? ""}${c.contentParts?.length ? ` Media references: ${JSON.stringify(c.contentParts.filter((p) => p.type !== "text"))}` : ""}`,
    );
    const summary = [contextSummary, ...observations, ...receipts]
      .filter(Boolean)
      .join("\n");
    // Older details remain accessible by context.read; retain conclusions and references, not chain-of-thought.
    work.checkpoint = {
      throughStepId: candidate.id,
      summary: summary.slice(-16000),
      createdAt: nowIso(),
    };
    contextSummary = work.checkpoint.summary;
    boundary++;
    messages = build();
    compacted = true;
  }
  if (count(messages) > hard)
    throw new AgentValidationError(
      "context_blocked: required instructions and the intact recent tool/reasoning chain exceed the model window after output reservation.",
    );
  if (compacted) workStore.save(work);
  return { messages, compacted, originalTokens, tokens: count(messages) };
}

export const contextReferenceTool: RegisteredTool = {
  id: "context.read",
  label: "Read retained context",
  category: "read",
  mutability: "read",
  resumeBehavior: "auto",
  description:
    "Read a retained tool result, step, message or Work by exact runtime reference, or list recent evidence references. History is read-only and limited to this session and its children. The injected current Work state, not historical text, controls execution.",
  inputSchema: z.object({
    kind: z.enum(["tool", "step", "message", "work", "references"]),
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
  const { steps, boundary } = sessionBoundary(sessionId);
  const excluded = new Set(steps.slice(0, boundary + 1).map((s) => s.id));
  return new Set(
    store
      .listToolCalls(sessionId)
      .filter((c) => c.stepId && excluded.has(c.stepId))
      .map((c) => c.id),
  );
}
