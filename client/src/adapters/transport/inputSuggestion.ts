import { apiFetch } from "./origin";

export interface NextInputSuggestionRequest {
  sessionId: string;
  projectId: string;
  /** Assistant text already streamed when the reply phase started. */
  replySoFar?: string;
  model?: string;
  backendId?: string;
}

/**
 * Ask the runtime for a hint of what the user will type next.
 *
 * The hint is optional: any failure resolves to `null` so the composer simply
 * shows no pre-fill, and a discarded hint never becomes a user-visible error.
 */
export async function suggestNextInput(
  input: NextInputSuggestionRequest,
  signal: AbortSignal,
): Promise<string | null> {
  const response = await apiFetch("/api/agent-runtime/input/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as {
    suggestion?: unknown;
  } | null;
  return typeof body?.suggestion === "string" && body.suggestion.trim()
    ? body.suggestion
    : null;
}
