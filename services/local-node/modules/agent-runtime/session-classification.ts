/**
 * Optional intent label that rides along with asynchronous session-title
 * generation.
 *
 * It is deliberately optional: a title stays useful when the model cannot tell
 * what the user wants, so classification never blocks or downgrades a title.
 */
export const SESSION_INTENT_CATEGORY_KEY = "intentCategory";

/** The category is a label, not a sentence: 2-10 characters. */
export const INTENT_CATEGORY_MIN_CHARS = 2;
export const INTENT_CATEGORY_MAX_CHARS = 10;

/**
 * Answers that mean "no category". The list panel renders its own
 * uncategorized bucket, so persisting one of these would create a duplicate.
 */
const EMPTY_CLASSIFICATION_VALUES = new Set([
  "",
  "none",
  "null",
  "n/a",
  "na",
  "undefined",
  "unknown",
  "无",
  "未知",
  "未分类",
  "其他",
]);

const EDGE_QUOTES = /^["'`「『【〈《(（]+|["'`」』】〉》)）]+$/gu;
const TRAILING_PUNCTUATION = /[。，、；：!?！？.,;:]+$/u;

function isMeaningful(value: string): boolean {
  return (
    Boolean(value) && !EMPTY_CLASSIFICATION_VALUES.has(value.toLocaleLowerCase())
  );
}

function stripModelDecoration(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(EDGE_QUOTES, "")
    .replace(TRAILING_PUNCTUATION, "")
    .trim();
}

/**
 * Normalize a model-proposed intent category.
 *
 * Returns null rather than truncating: a category that breaks the 2-10
 * character contract is a bad label, and a trimmed one would misdescribe the
 * session. Callers treat null as "leave the field out".
 */
export function normalizeIntentCategory(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = stripModelDecoration(raw);
  if (!isMeaningful(value)) return null;
  if (!/[\p{L}\p{N}]/u.test(value)) return null;
  const length = [...value].length;
  if (length < INTENT_CATEGORY_MIN_CHARS || length > INTENT_CATEGORY_MAX_CHARS)
    return null;
  return value;
}
