/** Canonical user input, with read compatibility for persisted pre-workspace sessions. */
export function readSessionUserPrompt(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  for (const value of [metadata?.userPrompt, metadata?.goalContent]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
