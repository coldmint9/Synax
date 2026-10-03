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

export function buildSessionUserMessage(input: {
  content: string;
  documentId?: string | null;
  documentTitle?: string | null;
  anchorJson?: unknown;
}): string {
  const request = input.content.trim();
  if (!input.documentId && !input.documentTitle && !input.anchorJson)
    return request;
  // References may contain instruction-like text; JSON escaping keeps them inside the data boundary.
  const reference = JSON.stringify({
    documentId: input.documentId,
    title: input.documentTitle,
    anchor: input.anchorJson,
  }).replace(/</g, "\\u003c");
  return `${request}\n\n<reference-context source="wiki">\n${reference}\n</reference-context>`;
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
      documentId:
        typeof metadata.documentId === "string" ? metadata.documentId : null,
    }),
  };
}
