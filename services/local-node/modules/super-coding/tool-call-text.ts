/**
 * Recognises a tool call that arrived as assistant *text* instead of a
 * structured call.
 *
 * Serving gateways sometimes pass the model's native tool-call encoding through
 * as plain answer text (DeepSeek `DSML` blocks, the older
 * `<|tool▁calls▁begin|>` markers, or an XML-ish `invoke name=` block). A run
 * then ends with that text as its final answer: nothing was executed, yet the
 * session reports success. Callers must treat such an answer as a failed
 * attempt, never as a delivered result.
 */

/** Full-width `｜` (U+FF5C) is the character the model actually emits. */
const PIPE = "[｜|]";
const DSML_CALLS = new RegExp(`<${PIPE}{2}DSML${PIPE}{2}\\s*calls>`, "u");
const DSML_INVOKE = new RegExp(
  `<${PIPE}{2}DSML${PIPE}{2}\\s*invoke\\s+name=`,
  "u",
);
const LEGACY_TOOL_CALL = new RegExp(
  `<${PIPE}tool▁calls▁begin${PIPE}>`,
  "u",
);
const FENCED_INVOKE = /```[a-z-]*[ \t]*\r?\n[ \t]*<?invoke\s+name=/iu;

export type ToolCallTextMarker = "dsml" | "legacy" | "invoke";

export interface ToolCallTextArtifact {
  /** Which encoding was found, so the failure can name the cause. */
  marker: ToolCallTextMarker;
  /** Bounded excerpt for logs; call arguments are deliberately dropped. */
  excerpt: string;
}

const EXCERPT_CHARS = 120;

/**
 * A leaked call is the whole answer (or follows one short lead-in sentence), so
 * the structure only counts near the start. Documentation or an incident report
 * that merely quotes these markers later in a long text stays untouched.
 */
const MARKER_WINDOW_CHARS = 200;
/** Leading whitespace that still counts as "at the start" while staying bounded. */
const HEAD_CHARS = MARKER_WINDOW_CHARS + 32;

/**
 * Returns the artifact when `text` is a tool call that never became a call.
 *
 * Kept narrow on purpose: a normal answer that merely *mentions* these markers
 * (documentation, bug reports) has no `calls>`/`invoke name=` structure and is
 * left alone.
 */
export function detectToolCallTextArtifact(
  text: string | null | undefined,
): ToolCallTextArtifact | null {
  if (typeof text !== "string") return null;
  // Bound the work up front: only the head can hold the marker, so the cost
  // never scales with the length of the answer (no full-string trim/copy).
  const head = text
    .slice(0, HEAD_CHARS)
    .trimStart()
    .slice(0, MARKER_WINDOW_CHARS);
  if (!head) return null;
  const marker: ToolCallTextMarker | null =
    DSML_CALLS.test(head) || DSML_INVOKE.test(head)
      ? "dsml"
      : LEGACY_TOOL_CALL.test(head)
        ? "legacy"
        : FENCED_INVOKE.test(head)
          ? "invoke"
          : null;
  if (!marker) return null;
  return { marker, excerpt: head.slice(0, EXCERPT_CHARS) };
}
