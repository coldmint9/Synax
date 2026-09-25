import { generateGatewayTextResult } from "../llm-runtime/gateway.js";
import { makeRuntimeId, nowIso } from "./runtime-ids.js";
import { agentRuntimeStore as store } from "./session-store.js";
import { workStore } from "./work-store.js";
import {
  COMPACTION_SYSTEM_PROMPT,
  serializeMessagesForSummary,
} from "./context-compressor.js";
import { countTokens } from "./context-tokenizer.js";
import {
  projectWorkContext,
  type ContextProjectionInput,
} from "./context-projection.js";
import { runtimeTransaction } from "./runtime-transaction.js";
import { logger } from "../../lib/logger.js";

const ACTIVE_THRESHOLD = 0.8;
const RECENT_MESSAGES = 4;
const MAX_SUMMARY_TOKENS = 12_000;

const LLM_COMPACTION_PROMPT = `${COMPACTION_SYSTEM_PROMPT}

This is a loss-minimizing context checkpoint, not a casual summary.
Preserve every user requirement, constraint, decision, unresolved issue, exact
file path, symbol, command, error message, and useful tool result. Organize the
answer under: Goal and constraints, Work completed, Decisions, Evidence,
Failures and caveats, Remaining work, and Retrieval references. Do not invent
facts. Keep identifiers verbatim. The original transcript remains available,
but the next model request will primarily rely on this checkpoint.`;

type Input = ContextProjectionInput & {
  projectId?: string;
  runId?: string | null;
  force?: boolean;
  onCompactionStart?: () => void;
};

export interface LlmCompactionResult {
  projection: ReturnType<typeof projectWorkContext>;
  didCompact: boolean;
  usedLlm: boolean;
}

function summaryBudget(contextLimit: number, outputReserve: number): number {
  const hard = Math.max(0, contextLimit - outputReserve);
  return Math.max(1_024, Math.min(MAX_SUMMARY_TOKENS, Math.floor(hard * 0.15)));
}

function withCompactionDiagnostic(
  projection: ReturnType<typeof projectWorkContext>,
  originalTokens: number,
  reason: string,
) {
  return {
    ...projection,
    compacted: true,
    originalTokens,
    compaction: projection.compaction
      ? {
          ...projection.compaction,
          compacted: true,
          originalTokens,
          projectedTokens: projection.tokens,
          reclaimedTokens: originalTokens - projection.tokens,
          reason,
        }
      : undefined,
  };
}

/**
 * Compacts at 80% using one full-history LLM summary, then persists only a
 * short checkpoint write. The deterministic projector remains the safety net.
 */
export async function maybeLlmCompactContext(
  input: Input,
): Promise<LlmCompactionResult> {
  const baseline = projectWorkContext({ ...input, forceCompact: false });
  const hard = Math.max(0, input.contextLimit - input.outputReserve);
  if (!input.force && baseline.originalTokens < hard * ACTIVE_THRESHOLD) {
    return { projection: baseline, didCompact: false, usedLlm: false };
  }

  // Existing checkpoint logic selects a safe complete-step boundary and keeps
  // user requirements/pinned steps intact. It also provides the fallback.
  input.onCompactionStart?.();
  const fallback = projectWorkContext({ ...input, forceCompact: true });
  if (!fallback.compacted) {
    return { projection: fallback, didCompact: false, usedLlm: false };
  }

  const source = serializeMessagesForSummary(
    baseline.messages.slice(0, Math.max(1, baseline.messages.length - RECENT_MESSAGES)),
  );
  logger.info(
    {
      sessionId: input.sessionId,
      originalTokens: baseline.originalTokens,
      threshold: hard * ACTIVE_THRESHOLD,
      summaryBudget: summaryBudget(input.contextLimit, input.outputReserve),
    },
    "[context-compaction] LLM summary started",
  );
  if (!source.trim()) {
    return { projection: fallback, didCompact: true, usedLlm: false };
  }

  let summary: string;
  try {
    const result = await generateGatewayTextResult({
      projectId: input.projectId,
      purpose: "context-compaction",
      model: input.model,
      messages: [
        { role: "system", content: LLM_COMPACTION_PROMPT },
        { role: "user", content: `Conversation history to checkpoint:\n\n${source}` },
      ],
      temperature: 0.2,
      maxTokens: summaryBudget(input.contextLimit, input.outputReserve),
    });
    summary = result.text.trim();
    if (!summary) throw new Error("empty context summary");
  } catch (error) {
    logger.warn(
      { sessionId: input.sessionId, err: error },
      "[context-compaction] LLM summary failed; using deterministic fallback",
    );
    return { projection: fallback, didCompact: true, usedLlm: false };
  }

  const work = workStore.current(input.sessionId);
  if (!work?.checkpoint) {
    return { projection: fallback, didCompact: true, usedLlm: false };
  }

  const compressedTokens = countTokens(summary, input.model);
  runtimeTransaction(() => {
    const latest = workStore.current(input.sessionId);
    if (!latest?.checkpoint) return;
    workStore.save({
      ...latest,
      checkpoint: { ...latest.checkpoint, summary },
    });
    store.saveCompactionRecord({
      id: makeRuntimeId("cmp"),
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      summaryText: summary,
      compressedMessageCount: baseline.messages.length,
      originalTokenCount: baseline.originalTokens,
      compressedTokenCount: compressedTokens,
      createdAt: nowIso(),
    });
  });

  const projection = projectWorkContext({ ...input, forceCompact: false });
  logger.info(
    {
      sessionId: input.sessionId,
      originalTokens: baseline.originalTokens,
      compressedTokens: projection.tokens,
      summaryTokens: compressedTokens,
    },
    "[context-compaction] LLM summary completed",
  );
  return {
    projection: withCompactionDiagnostic(
      projection,
      baseline.originalTokens,
      "llm-80-percent",
    ),
    didCompact: true,
    usedLlm: true,
  };
}
