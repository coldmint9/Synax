import * as z from "zod/v4";
import type { AgentSession } from "./contracts.js";

export const sideChatRequestSchema = z.object({
  reuse: z.boolean().default(true),
}).strict();
export type SideChatRequest = z.input<typeof sideChatRequestSchema>;

export interface SideChatContext {
  kind: "side-chat";
  sourceSessionId: string;
  /** Primary history revision captured by the snapshot copy. */
  sourceRevision: number;
  /**
   * Copy commit instant. The inherited snapshot stays in the child history so
   * the model keeps the primary conversation as context, while the side-chat
   * transcript renders only records created after it. Null until the copy is
   * committed.
   */
  inheritedThrough: string | null;
  createdAt: string;
}

export function isInteractiveSideChat(session: Pick<AgentSession, "sessionMetadata"> | { sessionMetadata?: Record<string, unknown> | null }): boolean {
  return session.sessionMetadata?.subagentKind === "side-chat";
}

/**
 * Only children with a committed snapshot boundary are reusable. Children from
 * before the boundary existed copied history without recording where it ended,
 * so reopening them would show the inherited transcript again.
 */
export function readSideChatContext(session: Pick<AgentSession, "sessionMetadata">): SideChatContext | undefined {
  const value = session.sessionMetadata?.sideChatContext as SideChatContext | undefined;
  return value?.kind === "side-chat" && typeof value.sourceSessionId === "string" &&
    Number.isSafeInteger(value.sourceRevision) && typeof value.createdAt === "string" &&
    (value.inheritedThrough === null || typeof value.inheritedThrough === "string") ? value : undefined;
}
