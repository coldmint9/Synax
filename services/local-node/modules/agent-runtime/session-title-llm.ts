import { generateGatewayTextResult } from "../../infrastructure/llm-runtime/gateway.js";
import { normalizeResultUsage } from "../../infrastructure/llm-runtime/usage.js";
import { logger } from "../../infrastructure/runtime/logger.js";
import { finishAuxUsage, startAuxUsage } from "./usage-projection.js";
import { normalizeIntentCategory } from "./session-classification.js";
import {
  listWorkspaceIntentLabels,
  reuseKnownIntentLabel,
} from "./session-intent-vocabulary.js";

/**
 * One title-generation answer.
 *
 * `title` is the only required field: the intent category is an extra the
 * session list may group by, and it can be missing.
 */
export interface SessionTitleGeneration {
  title: string;
  intentCategory: string | null;
}

const TITLE_TEXT_MAX_LEN = 50;

export function buildSessionTitlePrompt(
  userInput: string,
  knownLabels: string[] = [],
): string {
  return [
    "Analyse the user input below and answer with ONE JSON object, no prose.",
    'Shape: {"title": "...", "intentCategory": "..."}',
    "",
    '"title": at most 10 Chinese characters or 6 English words, no quotes or trailing punctuation.',
    '"intentCategory": 2-10 Chinese characters naming what the user wants, for example 缺陷修复 / 需求澄清 / 代码实现. Return "" when the request is too vague to label.',
    ...knownLabelInstructions(knownLabels),
    "",
    "User input:",
    userInput.slice(0, 600),
  ].join("\n");
}

/**
 * Labels this workspace already uses, so a new session reuses the vocabulary
 * instead of inventing a near-synonym that splits the list into two groups.
 */
function knownLabelInstructions(knownLabels: string[]): string[] {
  if (knownLabels.length === 0) return [];
  return [
    "",
    'Labels this workspace already uses. Prefer one of them verbatim when it fits; only invent a new label when none fits:',
    ...knownLabels.map((label) => `- ${label}`),
  ];
}

function jsonObjectFrom(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Parse a model answer.
 *
 * A model (or provider adapter) that ignores the JSON instruction still
 * produces a plain title, so unparseable output degrades to the old
 * title-only behaviour instead of losing the title.
 */
export function parseSessionTitleGeneration(
  text: string | null | undefined,
  knownLabels: string[] = [],
): SessionTitleGeneration | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;

  const object = jsonObjectFrom(raw);
  if (object) {
    const title = typeof object.title === "string" ? object.title.trim() : "";
    if (!title) return null;
    const intentCategory = normalizeIntentCategory(object.intentCategory);
    return {
      title: title.slice(0, TITLE_TEXT_MAX_LEN),
      intentCategory: intentCategory
        ? reuseKnownIntentLabel(intentCategory, knownLabels)
        : null,
    };
  }

  return { title: raw.slice(0, TITLE_TEXT_MAX_LEN), intentCategory: null };
}

/**
 * Single model call that produces the session title and its optional label.
 *
 * Shared by the registered profile generator and the built-in fallback so the
 * prompt exists once.
 */
export async function generateSessionTitleWithModel(input: {
  sessionId: string;
  projectId: string;
  userInput: string;
}): Promise<SessionTitleGeneration | null> {
  const usageId = startAuxUsage(input.sessionId, "session-title");
  try {
    const knownLabels = listWorkspaceIntentLabels(input.projectId);
    const result = await generateGatewayTextResult(
      {
        projectId: input.projectId,
        purpose: "session-title",
        messages: [
          {
            role: "user",
            content: buildSessionTitlePrompt(input.userInput, knownLabels),
          },
        ],
        maxTokens: 2048,
        maxRetries: 0,
        temperature: 0.3,
      },
      AbortSignal.timeout(22_000),
    );

    finishAuxUsage(usageId, normalizeResultUsage(result));
    return parseSessionTitleGeneration(result.text, knownLabels);
  } catch (err) {
    finishAuxUsage(usageId);
    logger.warn(
      { sessionId: input.sessionId, err },
      "[session-title] LLM title generation failed",
    );
    return null;
  }
}
