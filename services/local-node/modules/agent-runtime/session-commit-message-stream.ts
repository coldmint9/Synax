import {
  createGatewayStreamForSelection,
  resolveGatewaySelection,
} from "../../infrastructure/llm-runtime/gateway.js";
import { normalizeUsage } from "../../infrastructure/llm-runtime/usage.js";
import { logger } from "../../infrastructure/runtime/logger.js";
import type { LlmGatewayRequest } from "../../infrastructure/llm-runtime/types.js";
import { finishAuxUsage, startAuxUsage } from "./usage-projection.js";
import {
  MAX_COMMIT_MESSAGE_LEN,
  normalizeCommitMessage,
} from "./session-git-commit.js";
import {
  collectCommitMessageContext,
  type CommitMessageContext,
} from "./session-commit-message-context.js";
import {
  deterministicCommitTitle,
  mergeBatchAnswers,
  planCommitMessageBatches,
  renderBatchPrompt,
  stripReasoning,
  type CommitMessageBatch,
  type CommitMessageLocale,
} from "./session-commit-message-changelog.js";
import { resolvePromptLocale } from "../prompts/locale-infer.js";
import { AgentRuntimeError } from "./runtime-errors.js";

/**
 * One batch is one template prompt and one short answer, so this is a ceiling
 * for a single batch, not a budget shared by the whole generation.
 */
export const COMMIT_MESSAGE_TIMEOUT_MS = 120_000;
/** Batches run in parallel; this keeps a huge commit from flooding a provider. */
export const COMMIT_MESSAGE_CONCURRENCY = 4;
/**
 * A batch that answers nothing usable gets one more attempt: a single provider
 * hiccup must not be reported as a model that never finished.
 */
export const COMMIT_MESSAGE_BATCH_ATTEMPTS = 2;
/** Short pause before that attempt, so a rate limit has room to clear. */
export const COMMIT_MESSAGE_RETRY_DELAY_MS = 300;
const MAX_RAW_MESSAGE_CHARS = 32_000;
/**
 * The answer is a title and a few bullets, but a reasoning model bills its
 * thinking against the same cap. A model that cannot switch thinking off spends
 * any smaller cap entirely on reasoning and answers with nothing, so this stays
 * a cap, not a target: it is only ever billed for the tokens really produced.
 */
const MAX_BATCH_TOKENS = 8_192;
/** Longest provider message echoed into the review warning. */
const MAX_REASON_CHARS = 160;
const USAGE_FIELDS = [
  "inputTokens",
  "promptTokens",
  "outputTokens",
  "completionTokens",
  "totalTokens",
  "reasoningTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
] as const;

/** The commit message arrives once, after every batch has been folded together. */
export type CommitMessageEvent = {
  type: "final";
  message: string;
  warning?: string;
};

export interface CommitMessageGenerationInput {
  rootId?: string;
  /** Generate against the selected destination branch while reading the current worktree diff. */
  branch?: string;
  /** Keep the generated diff aligned with the files the commit will stage. */
  includeUntracked?: boolean;
  model: string;
  /** Interface language for the generated message; inferred from history when absent. */
  locale?: "zh" | "en";
  /** Test seam: shorten the per-batch budget. HTTP callers never set this. */
  timeoutMs?: number;
}

export interface CommitMessageGeneration {
  sessionId: string;
  model: string;
  locale: CommitMessageLocale;
  context: CommitMessageContext;
  selection: Awaited<ReturnType<typeof resolveGatewaySelection>>;
  batches: CommitMessageBatch[];
  /** Budget of one batch; every batch gets its own. */
  timeoutMs: number;
}

type UsageTotal = Record<string, number>;

interface BatchOutcome {
  batch: CommitMessageBatch;
  text: string;
  usage?: UsageTotal;
  /** True when this batch answered nothing usable and fell back to a summary. */
  degraded: boolean;
  /** The answer was cut by the output cap, even if a title survived. */
  truncated: boolean;
  /** Set when the batch produced no answer; explains the degraded message. */
  failure?: BatchFailure;
}

interface StreamOutcome {
  text: string;
  truncated: boolean;
  usage?: UsageTotal;
}

/** Why one batch produced nothing, in terms the reviewer can act on. */
interface BatchFailure {
  timedOut: boolean;
  /** The provider stopped at the output cap before writing an answer. */
  truncated: boolean;
  /** Provider or runtime message, flattened and bounded. */
  reason?: string;
}

type BatchAttempt =
  | { answered: true; outcome: StreamOutcome }
  | { answered: false; failure: BatchFailure };

/** A short, low-effort answer is what keeps one batch inside its deadline. */
function buildRequest(
  prepared: CommitMessageGeneration,
  batch: CommitMessageBatch,
  reasoningEffort: "none" | "low",
): LlmGatewayRequest {
  return {
    projectId: prepared.context.projectId,
    purpose: "commit-message",
    model: prepared.model,
    reasoningEffort,
    maxTokens: MAX_BATCH_TOKENS,
    messages: [
      {
        role: "user",
        content: renderBatchPrompt(batch, prepared.context, prepared.locale),
      },
    ],
  };
}

/**
 * A commit message is formatting, not analysis. When the model can turn its
 * thinking off, it must: a thinking model otherwise spends the whole output
 * budget before writing a single answer token.
 */
function batchReasoningEffort(
  selection: CommitMessageGeneration["selection"],
): "none" | "low" {
  const declared =
    selection.config.supportedReasoningEfforts ??
    selection.modelDef.supportedReasoningEfforts;
  return declared?.includes("none") ? "none" : "low";
}

/**
 * The retry falls back to the effort used before: a gateway that advertises
 * "none" but rejects it must still get one ordinary attempt instead of failing
 * the whole message.
 */
function retryReasoningEffort(effort: "none" | "low"): "none" | "low" {
  return effort === "none" ? "low" : effort;
}

export async function prepareCommitMessageGeneration(
  sessionId: string,
  input: CommitMessageGenerationInput,
): Promise<CommitMessageGeneration> {
  const context =
    input.includeUntracked === undefined && input.branch === undefined
      ? await collectCommitMessageContext(sessionId, input.rootId)
      : await collectCommitMessageContext(
          sessionId,
          input.rootId,
          input.includeUntracked ?? true,
          input.branch,
        );
  const locale = resolvePromptLocale(
    input.locale,
    context.subjects.join("\n"),
  ) as CommitMessageLocale;
  const selection = await resolveGatewaySelection({
    projectId: context.projectId,
    purpose: "commit-message",
    model: input.model,
  });
  if (!selection.provider.supported)
    throw new AgentRuntimeError(
      "The selected API model is not available.",
      "GIT_MODEL_UNAVAILABLE",
      422,
    );
  return {
    sessionId,
    model: input.model,
    locale,
    context,
    selection,
    batches: planCommitMessageBatches(context.files),
    timeoutMs: Math.max(1, input.timeoutMs ?? COMMIT_MESSAGE_TIMEOUT_MS),
  };
}

function addUsage(total: UsageTotal | undefined, raw: unknown): UsageTotal | undefined {
  if (!raw || typeof raw !== "object") return total;
  const record = raw as Record<string, unknown>;
  let next = total;
  for (const field of USAGE_FIELDS) {
    const value = record[field];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    next ??= {};
    next[field] = (next[field] ?? 0) + value;
  }
  return next;
}

/** Rejects as soon as the deadline or the caller aborts, even mid-await. */
function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/**
 * Collect one batch answer. Every wait races the signal, so a provider that
 * stops sending events still ends this batch on time.
 */
async function completeBatch(
  request: LlmGatewayRequest,
  selection: CommitMessageGeneration["selection"],
  signal: AbortSignal,
): Promise<StreamOutcome> {
  const aborted = abortRejection(signal);
  const result = await Promise.race([
    createGatewayStreamForSelection(request, selection, signal),
    aborted,
  ]);
  const events = result.fullStream[Symbol.asyncIterator]();
  let text = "";
  let truncated = false;
  let usage: UsageTotal | undefined;
  try {
    for (;;) {
      const next = await Promise.race([events.next(), aborted]);
      if (next.done) break;
      const event = next.value;
      signal.throwIfAborted();
      if (event.type === "text-delta") {
        text += event.text;
        if (text.length > MAX_RAW_MESSAGE_CHARS)
          throw new AgentRuntimeError(
            "Generated commit message is too long.",
            "GIT_COMMIT_MESSAGE_TOO_LONG",
            422,
          );
        continue;
      }
      if (event.type === "finish") {
        usage = addUsage(
          usage,
          normalizeUsage(event.totalUsage, { source: "native" }),
        );
        truncated = event.finishReason === "length";
        continue;
      }
      if (event.type === "error") throw event.error;
      if (event.type === "abort")
        throw new DOMException("Generation cancelled.", "AbortError");
    }
  } finally {
    // A raced-out iterator is abandoned; releasing it is best effort.
    void events.return?.();
  }
  signal.throwIfAborted();
  return { text, truncated, usage };
}

/** Drop a partially written trailing line; complete lines stay reviewable. */
function completeLines(text: string): string {
  const end = text.lastIndexOf("\n");
  return end === -1 ? "" : text.slice(0, end + 1);
}

async function runBatch(
  prepared: CommitMessageGeneration,
  batch: CommitMessageBatch,
  signal?: AbortSignal,
): Promise<BatchOutcome> {
  const firstEffort = batchReasoningEffort(prepared.selection);
  let failure: BatchFailure | undefined;
  for (
    let attempt = 1;
    attempt <= COMMIT_MESSAGE_BATCH_ATTEMPTS;
    attempt += 1
  ) {
    const result = await attemptBatch(
      prepared,
      batch,
      attempt === 1 ? firstEffort : retryReasoningEffort(firstEffort),
      signal,
    );
    if (result.answered) {
      const text = result.outcome.truncated
        ? completeLines(result.outcome.text)
        : result.outcome.text;
      // An empty answer is the same review problem as a failed request, so an
      // unused attempt is spent on it instead of degrading the message.
      if (!text.trim() && attempt < COMMIT_MESSAGE_BATCH_ATTEMPTS) {
        failure = { timedOut: false, truncated: result.outcome.truncated };
        await retryDelay(signal);
        continue;
      }
      return {
        batch,
        text,
        usage: result.outcome.usage,
        degraded: result.outcome.truncated,
        truncated: result.outcome.truncated,
      };
    }
    failure = result.failure;
    // A provider that already used the whole batch deadline gains nothing from
    // a second wait, so only immediate failures are retried.
    if (result.failure.timedOut) break;
    if (attempt < COMMIT_MESSAGE_BATCH_ATTEMPTS) await retryDelay(signal);
  }
  logger.warn(
    {
      sessionId: prepared.sessionId,
      batch: batch.index,
      batches: batch.count,
      files: batch.files.length,
      timedOut: failure?.timedOut === true,
      truncated: failure?.truncated === true,
      error: failure?.reason,
    },
    "Commit message batch produced no answer; grounded summary filled in",
  );
  return {
    batch,
    text: "",
    degraded: true,
    truncated: failure?.truncated === true,
    ...(failure ? { failure } : {}),
  };
}

/**
 * One attempt for one batch. A provider failure is an outcome, not an
 * exception: only the caller's cancellation ends the whole generation.
 */
async function attemptBatch(
  prepared: CommitMessageGeneration,
  batch: CommitMessageBatch,
  reasoningEffort: "none" | "low",
  signal?: AbortSignal,
): Promise<BatchAttempt> {
  // Every batch owns its deadline, and the caller's abort is forwarded to this
  // batch alone; both are released when the batch ends.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort(
        new DOMException("Commit message batch timed out.", "TimeoutError"),
      );
    },
    prepared.timeoutMs,
  );
  const forward = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", forward, { once: true });
  try {
    return {
      answered: true,
      outcome: await completeBatch(
        buildRequest(prepared, batch, reasoningEffort),
        prepared.selection,
        controller.signal,
      ),
    };
  } catch (error) {
    // Cancelling is a user decision; one failed batch must not void the others.
    if (signal?.aborted) throw error;
    return {
      answered: false,
      failure: { timedOut, truncated: false, ...failureReason(error) },
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}

/** Flatten a provider/runtime message into one bounded, log-safe sentence. */
function failureReason(error: unknown): { reason?: string } {
  const message = error instanceof Error ? error.message : String(error);
  const reason = message.replace(/\s+/g, " ").trim().slice(0, MAX_REASON_CHARS);
  return reason ? { reason } : {};
}

/** Pause before a retry; a cancellation during the pause still wins. */
async function retryDelay(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, COMMIT_MESSAGE_RETRY_DELAY_MS);
  });
  signal?.throwIfAborted();
}

/** Run the batches concurrently, keeping the pool small and the order stable. */
async function runBatches(
  prepared: CommitMessageGeneration,
  onUsage: (usage: UsageTotal | undefined) => void,
  signal?: AbortSignal,
): Promise<BatchOutcome[]> {
  const outcomes: BatchOutcome[] = new Array(prepared.batches.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      const batch = prepared.batches[index];
      if (!batch) return;
      const outcome = await runBatch(prepared, batch, signal);
      onUsage(outcome.usage);
      outcomes[index] = outcome;
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(COMMIT_MESSAGE_CONCURRENCY, prepared.batches.length) },
      worker,
    ),
  );
  return outcomes;
}

function answerTitle(text: string): string {
  return normalizeCommitMessage(stripReasoning(text)).split(/\r?\n/, 1)[0] ?? "";
}

/** What the reviewer needs to know about a message that is only partly model-written. */
interface DegradedNotes {
  /** Batches whose answer is missing or cut short. */
  affected: number;
  total: number;
  reason?: string;
  timedOut: boolean;
  truncated: boolean;
}

function degradedWarning(
  locale: CommitMessageLocale,
  notes: DegradedNotes,
): string {
  const cause = notes.timedOut
    ? locale === "zh"
      ? "请求超时"
      : "the request timed out"
    : (notes.reason ??
      (notes.truncated
        ? locale === "zh"
          ? "输出被长度上限截断"
          : "the output token limit was reached"
        : undefined));
  // Without a concrete cause there is nothing better to say than the fallback.
  if (!cause)
    return locale === "zh"
      ? "模型未能完成生成，已按变更范围生成摘要，请检查后修改。"
      : "The model did not finish, so this message summarizes the changed files by area. Review it before committing.";
  if (locale === "zh")
    return notes.affected >= notes.total
      ? `模型生成未完成（${cause}），已按变更范围生成摘要，请检查后修改。`
      : `有 ${notes.affected}/${notes.total} 批文件生成未完成（${cause}），已按变更范围补齐摘要，请检查后修改。`;
  if (notes.affected >= notes.total)
    return `The model did not finish (${cause}), so this message summarizes the changed files by area. Review it before committing.`;
  return `${notes.affected} of ${notes.total} batches did not finish (${cause}); those areas were summarized from the changed files. Review it before committing.`;
}

export async function* streamSessionCommitMessage(
  prepared: CommitMessageGeneration,
  signal?: AbortSignal,
): AsyncGenerator<CommitMessageEvent> {
  const usageId = startAuxUsage(prepared.sessionId, "git-commit-message");
  let usage: UsageTotal | undefined;
  try {
    signal?.throwIfAborted();
    const outcomes = await runBatches(
      prepared,
      (batchUsage) => {
        usage = addUsage(usage, batchUsage);
      },
      signal,
    );
    // The first batch answers with the most significant change; a silent first
    // batch must not throw away a title another batch did write.
    const title = outcomes.map((outcome) => answerTitle(outcome.text)).find(Boolean) ?? "";
    const failures = outcomes.flatMap((outcome) =>
      outcome.failure ? [outcome.failure] : [],
    );
    const incomplete = outcomes.filter((outcome) => outcome.degraded);
    yield {
      type: "final",
      message: mergeBatchAnswers(outcomes, {
        title: title || deterministicCommitTitle(prepared.context, prepared.locale),
        locale: prepared.locale,
        maxChars: MAX_COMMIT_MESSAGE_LEN,
      }),
      ...(!title || incomplete.length > 0
        ? {
            warning: degradedWarning(prepared.locale, {
              affected: incomplete.length,
              total: outcomes.length,
              ...(failures[0]?.reason ? { reason: failures[0].reason } : {}),
              timedOut: failures.some((failure) => failure.timedOut),
              truncated: incomplete.some((outcome) => outcome.truncated),
            }),
          }
        : {}),
    };
  } finally {
    finishAuxUsage(usageId, usage);
  }
}
