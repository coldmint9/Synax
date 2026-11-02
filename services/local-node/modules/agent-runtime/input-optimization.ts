import { createGatewayStream } from "../../infrastructure/llm-runtime/gateway.js";
import { resolveInputAssistModel } from "./input-assist-model.js";
import {
  INPUT_OPTIMIZATION_SYSTEM_PROMPT,
  classifyDraft,
  detectRewriteStructure,
  rewriteFocus,
  type DraftIntent,
  type RewriteStructure,
} from "./input-optimization-policy.js";
import { AgentRuntimeError, AgentValidationError } from "./runtime-errors.js";

export const MAX_OPTIMIZATION_INPUT_CHARS = 32_000;
export const INPUT_OPTIMIZATION_TIMEOUT_MS = 60_000;

export interface InputOptimizationResult {
  text: string;
  status: "optimized" | "unchanged";
  /** What the draft asked for; the rewrite policy follows from it. */
  intent: DraftIntent;
  /** Structure the returned draft actually uses. */
  structure: RewriteStructure;
}

export interface InputOptimizationRequest {
  projectId: string;
  text: string;
  model?: string;
  backendId?: string;
}

function outputTokenBudget(text: string): number {
  // Leave room for non-Latin text and modest intent expansion, without reasoning tokens.
  return Math.min(32_768, Math.max(4_096, Math.ceil(text.length * 3) + 2_048));
}

type OutputIssue = "empty" | "length" | "filtered" | "unfinished" | "oversized";

function classifyOutput(result: {
  text: string;
  finishReason: string;
}): OutputIssue | null {
  if (result.finishReason === "content-filter") return "filtered";
  if (result.finishReason === "length") return "length";
  if (result.finishReason !== "stop") return "unfinished";
  if (!result.text.trim()) return "empty";
  if (result.text.length > MAX_OPTIMIZATION_INPUT_CHARS) return "oversized";
  return null;
}

function outputError(issue: OutputIssue): AgentRuntimeError {
  const errors: Record<OutputIssue, [string, string]> = {
    empty: [
      "模型未返回可用的优化文本，原文已保留，请重试或更换输入优化模型 / The model returned no usable edited text. Your draft was kept. Retry or choose another input optimization model.",
      "INPUT_OPTIMIZATION_EMPTY",
    ],
    length: [
      "优化结果被输出上限截断，原文已保留，请缩短输入或更换输入优化模型 / The output limit truncated the result. Your draft was kept. Shorten the draft or choose another input optimization model.",
      "INPUT_OPTIMIZATION_TRUNCATED",
    ],
    filtered: [
      "模型服务的内容过滤阻止了本次优化，原文已保留 / The provider's content filter blocked optimization. Your draft was kept.",
      "INPUT_OPTIMIZATION_FILTERED",
    ],
    unfinished: [
      "模型未正常结束优化，原文已保留，请重试或更换输入优化模型 / The model did not finish normally. Your draft was kept. Retry or choose another input optimization model.",
      "INPUT_OPTIMIZATION_INCOMPLETE",
    ],
    oversized: [
      "优化结果超过 32000 字符，原文已保留，请缩短输入后重试 / The result exceeds 32000 characters. Your draft was kept. Shorten the draft and retry.",
      "INPUT_OPTIMIZATION_TOO_LONG",
    ],
  };
  const [message, code] = errors[issue];
  return new AgentRuntimeError(message, code, 422);
}

/** A tool-free, isolated request: never appends a turn or runs workspace actions. */
export async function optimizeInput(
  input: InputOptimizationRequest,
  signal?: AbortSignal,
  onDelta?: (text: string) => void | Promise<void>,
): Promise<InputOptimizationResult> {
  if (!input.text.trim() || input.text.length > MAX_OPTIMIZATION_INPUT_CHARS)
    throw new AgentValidationError(
      "输入不能为空且不能超过 32000 字符 / Enter 1–32000 characters.",
    );

  const model = resolveInputAssistModel(input);
  const intent = classifyDraft(input.text);
  const abortSignal = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(INPUT_OPTIMIZATION_TIMEOUT_MS),
  ]);
  abortSignal.throwIfAborted();

  const systemPrompt = `${INPUT_OPTIMIZATION_SYSTEM_PROMPT}\n\nRewrite focus: ${rewriteFocus(intent)}`;
  const stream = await createGatewayStream(
    {
      projectId: input.projectId,
      purpose: "input-optimization",
      model,
      reasoningEffort: "none",
      temperature: 0.3,
      maxTokens: outputTokenBudget(input.text),
      maxRetries: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: input.text },
      ],
    },
    abortSignal,
  );
  let text = "";
  for await (const part of stream.fullStream) {
    abortSignal.throwIfAborted();
    if (part.type === "error") throw part.error;
    if (part.type === "text-delta") {
      text += part.text;
      if (text.length > MAX_OPTIMIZATION_INPUT_CHARS) throw outputError("oversized");
      await onDelta?.(part.text);
    }
  }
  abortSignal.throwIfAborted();
  const issue = classifyOutput({ text, finishReason: await stream.finishReason });
  if (issue) throw outputError(issue);
  if (text.trim() === input.text.trim())
    return {
      text: input.text,
      status: "unchanged",
      intent,
      structure: detectRewriteStructure(input.text, intent),
    };
  return {
    text,
    status: "optimized",
    intent,
    structure: detectRewriteStructure(text, intent),
  };
}
