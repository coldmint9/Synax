/** Read current session input first, with a fallback for persisted pre-workspace sessions. */
export function getSessionUserPrompt(
  metadata: { userPrompt?: unknown; goalContent?: unknown } | null | undefined,
): string | null {
  for (const value of [metadata?.userPrompt, metadata?.goalContent]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** The historical source value stays readable; new clients write agent-dock. */
export function isAgentDockSource(source: unknown): boolean {
  return source === "agent-dock" || source === "goal-dock";
}

export function isSessionComposerSource(source: unknown): boolean {
  return source === "session-page" || isAgentDockSource(source);
}

/** Canonicalize newly created sessions without rewriting stored session history. */
export function normalizeSessionPromptMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const { goalContent, ...normalized } = metadata ?? {};
  if (
    !(
      typeof normalized.userPrompt === "string" && normalized.userPrompt.trim()
    ) &&
    typeof goalContent === "string" &&
    goalContent.trim()
  )
    normalized.userPrompt = goalContent;
  if (isAgentDockSource(normalized.source)) normalized.source = "agent-dock";
  return normalized;
}
