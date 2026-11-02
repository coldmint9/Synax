import { generateGatewayTextResult } from "../../infrastructure/llm-runtime/gateway.js";
import { resolveInputAssistModel, type InputAssistSelection } from "./input-assist-model.js";

/** Hard cap for the whole hint call; the client aborts at the same deadline. */
export const NEXT_INPUT_SUGGESTION_TIMEOUT_MS = 6_000;
export const NEXT_INPUT_SUGGESTION_MAX_CHARS = 160;
const MAX_REQUEST_CHARS = 2_000;
const MAX_REPLY_CHARS = 1_500;
const MAX_ACTIVITY_ITEMS = 8;
const MAX_ACTIVITY_ITEM_CHARS = 160;

export interface NextInputActivityItem {
  toolId: string;
  summary: string;
}

export interface NextInputSuggestionRequest extends InputAssistSelection {
  projectId: string;
  /** The user's most recent request, which the conversation is still answering. */
  userRequest: string;
  /** Assistant text already streamed when the final reply phase started. */
  replySoFar?: string;
  /** Tools the assistant ran for this turn, oldest first. */
  activity?: NextInputActivityItem[];
}

const SYSTEM_PROMPT = `You predict the next message a developer will send in an AI coding workspace.
You are given their last request, the tools the assistant ran for it, and the beginning of the reply that is still streaming.
Write the single most likely message they will type next: a concrete follow-up action ("run the tests", "commit and push", "apply the same change to the settings page") or a short follow-up question.
Rules:
- One short sentence, at most 12 words or 80 characters.
- Same language as the user's request.
- Reply with the message only: no quotes, no markdown, no labels, no preamble, no explanation.
- Stay grounded in the given context. Never invent file names, versions, requirements, or results.
- If no next message is plausible, reply with an empty line.`;

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/** Build the single user message; exported so the prompt stays testable. */
export function buildNextInputSuggestionPrompt(
  request: Pick<NextInputSuggestionRequest, "userRequest" | "replySoFar" | "activity">,
): string {
  const sections = [
    `Last user request:\n${clip(request.userRequest, MAX_REQUEST_CHARS)}`,
  ];
  const activity = (request.activity ?? [])
    .filter((item) => item.toolId.trim())
    .slice(-MAX_ACTIVITY_ITEMS);
  if (activity.length > 0)
    sections.push(
      `Tools run for it:\n${activity
        .map((item) => `- ${item.toolId}: ${clip(item.summary, MAX_ACTIVITY_ITEM_CHARS)}`)
        .join("\n")}`,
    );
  const reply = request.replySoFar?.trim();
  if (reply)
    sections.push(`Reply so far:\n${clip(reply, MAX_REPLY_CHARS)}`);
  return sections.join("\n\n");
}

/**
 * Keep only what the composer can pre-fill: one line, no wrapping quotes, no
 * markdown fence, no trailing commentary.
 */
export function normalizeNextInputSuggestion(value: string | null | undefined): string | null {
  if (!value) return null;
  // A fenced answer carries its fences on their own lines; the hint is the
  // first real line inside them, not the fence label.
  const line = value
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0 && !/^```[\w-]*$/.test(part));
  if (!line) return null;
  const unquoted = line
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
    .trim();
  if (!unquoted) return null;
  return unquoted.length <= NEXT_INPUT_SUGGESTION_MAX_CHARS
    ? unquoted
    : `${unquoted.slice(0, NEXT_INPUT_SUGGESTION_MAX_CHARS).trimEnd()}…`;
}

/**
 * One tool-free, isolated call that never appends a turn or touches workspace
 * state. Returns `null` instead of throwing when the hint cannot be produced:
 * the composer treats a missing hint as "no suggestion", never as an error.
 */
export async function suggestNextInput(
  request: NextInputSuggestionRequest,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!request.userRequest.trim()) return null;
  let model: string;
  try {
    model = resolveInputAssistModel(request);
  } catch {
    return null;
  }
  const abortSignal = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(NEXT_INPUT_SUGGESTION_TIMEOUT_MS),
  ]);
  abortSignal.throwIfAborted();
  const result = await generateGatewayTextResult(
    {
      projectId: request.projectId,
      purpose: "input-suggestion",
      model,
      reasoningEffort: "none",
      temperature: 0.4,
      maxTokens: 256,
      maxRetries: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildNextInputSuggestionPrompt(request) },
      ],
    },
    abortSignal,
  );
  abortSignal.throwIfAborted();
  if (result.finishReason === "length" || result.finishReason === "content-filter")
    return null;
  return normalizeNextInputSuggestion(result.text);
}
