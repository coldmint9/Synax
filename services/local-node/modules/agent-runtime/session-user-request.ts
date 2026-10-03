import type { AgentSession } from "./contracts.js";
import { getSessionUserPrompt } from "./session-metadata.js";

/** Only unwrap application-authored initial messages; never parse arbitrary user Markdown as instructions. */
export function resolveSessionUserRequest(
  session: Pick<AgentSession, "prompt" | "sessionMetadata">,
  message: string,
): string {
  const metadata = session.sessionMetadata;
  const userPrompt = getSessionUserPrompt(metadata);
  if (
    metadata?.source === "session-page" &&
    message.trim() === session.prompt.trim() &&
    userPrompt
  ) {
    return userPrompt;
  }
  return message.trim();
}

export function buildSessionUserMessage(input: { content: string }): string {
  return input.content.trim();
}

/** Project old app scaffolding into the new request shape without rewriting stored history. */
export function initialSessionMessageProjection(
  session: Pick<AgentSession, "prompt" | "sessionMetadata">,
): { original: string; content: string } | undefined {
  const metadata = session.sessionMetadata;
  if (metadata?.source !== "session-page") return undefined;
  const original = session.prompt.trim();
  const raw = getSessionUserPrompt(metadata);
  if (!raw || original === raw) return undefined;
  // Already-authored references are preserved byte-for-byte. Only the known legacy scaffold is replaced.
  if (
    !original.startsWith("## Language Output Directive") ||
    !original.includes("## User Goal")
  )
    return undefined;
  return {
    original,
    content: buildSessionUserMessage({
      content: raw,
    }),
  };
}
