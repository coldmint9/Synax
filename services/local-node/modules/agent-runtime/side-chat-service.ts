import type { AgentSession } from "./contracts.js";
import { AgentNotFoundError, AgentRuntimeError, AgentValidationError } from "./runtime-errors.js";
import { createInteractiveSideChat } from "./subagent-delegation.js";
import { agentRuntimeStore } from "./session-store.js";
import { ensureSessionRecovered } from "./session-recovery.js";
import { runtimeFacade } from "./sidecar/runtime-facade.js";
import { withSessionWorkspaceLock } from "./session-workspace-lock.js";
import { isInteractiveSideChat, readSideChatContext, sideChatRequestSchema,
  type SideChatContext, type SideChatRequest } from "./side-chat-contract.js";

/** Durable copy input so a retried open replays the same atomic snapshot. */
interface SideChatCopy {
  revision: number;
  allowSourceChanges: boolean;
  metadata: Record<string, unknown>;
}

/** Children that occupy this primary conversation's side-chat slot. */
function sideChatChildren(
  sessions: AgentSession[],
  parentSessionId: string,
): AgentSession[] {
  return sessions.filter(child =>
    child.parentSessionId === parentSessionId && isInteractiveSideChat(child) &&
    !child.sessionMetadata?.deletedAt && !child.sessionMetadata?.archivedAt &&
    readSideChatContext(child)?.sourceSessionId === parentSessionId);
}

/**
 * Only children with a committed snapshot boundary can be reopened: the
 * inherited history ends where the copy ended, so the side chat shows just its
 * own turns.
 */
function reusableSideChat(children: AgentSession[]): AgentSession | undefined {
  return children.filter(child =>
    child.sessionMetadata?.sideChatReady === true &&
    readSideChatContext(child)!.inheritedThrough !== null,
  ).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/**
 * A side chat is a temporary conversation beside the primary session. Its model
 * context starts from a snapshot of the primary history, but the transcript
 * renders only what is exchanged in the side chat itself. It shares the primary
 * workspace, tools and permissions. Opening is serialized with workspace/run
 * admission so it cannot race the primary run.
 */
export function openSideChat(parentSessionId: string, request: SideChatRequest = {}) {
  const input = sideChatRequestSchema.parse(request);
  return withSessionWorkspaceLock(parentSessionId, async () => {
    await ensureSessionRecovered(parentSessionId);
    await agentRuntimeStore.hydrateSessionSummary(parentSessionId, true);
    const parent = agentRuntimeStore.getSession(parentSessionId);
    if (parent.sessionMetadata?.archivedAt || parent.sessionMetadata?.deletedAt)
      throw new AgentNotFoundError(parentSessionId);
    if (parent.parentSessionId)
      throw new AgentValidationError("Open side chat from a primary conversation.");
    if (parent.status === "stopping" || parent.sessionMetadata?.runtimeControl)
      throw new AgentRuntimeError("Wait for the primary conversation to finish stopping.", "ANCESTOR_STOPPING", 409);

    const sessions = await runtimeFacade.listSessionProjection() as AgentSession[];
    const children = sideChatChildren(sessions, parentSessionId);

    const ready = input.reuse ? reusableSideChat(children) : undefined;
    if (ready) {
      const session = (await runtimeFacade.uiSnapshotAuthoritative(ready.id)).session;
      return { session, sideChatContext: readSideChatContext(session) ?? readSideChatContext(ready)!, reused: true };
    }

    // A previous open that never published readiness owns the copy receipt;
    // finishing it keeps concurrent and restarted opens on one child.
    const preparing = input.reuse ? children.filter(child => {
      const copy = child.sessionMetadata?.sideChatCopy as SideChatCopy | undefined;
      return child.sessionMetadata?.sideChatReady !== true && child.sessionMetadata?.forkPreparing === true && Boolean(copy);
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] : undefined;

    let child = preparing;
    if (!child) {
      const head = await runtimeFacade.historyHeadAuthoritative(parentSessionId);
      child = await createInteractiveSideChat(parentSessionId,
        "Side chat beside the primary conversation.", { forkPreparing: true });
      const context: SideChatContext = {
        kind: "side-chat", sourceSessionId: parentSessionId, sourceRevision: head.revision,
        inheritedThrough: null, createdAt: new Date().toISOString(),
      };
      const metadata = { ...child.sessionMetadata, mode: "chat", subagentKind: "side-chat",
        sideChatContext: context, sideChatReady: false, forkPreparing: true };
      agentRuntimeStore.updateSessionMetadata(child.id, { ...metadata, sideChatCopy: {
        revision: head.revision, allowSourceChanges: true, metadata,
      } satisfies SideChatCopy });
      await agentRuntimeStore.flushSession(child.id);
      await agentRuntimeStore.flushSession(parentSessionId);
      child = agentRuntimeStore.getSession(child.id);
    }
    await agentRuntimeStore.hydrateSessionSummary(child.id, true);
    const copy = child.sessionMetadata?.sideChatCopy as SideChatCopy | undefined;
    if (!copy) throw new AgentRuntimeError("The side chat snapshot has no recovery information.", "SIDE_CHAT_COPY_INVALID", 409);
    const context = readSideChatContext(child) ?? {
      kind: "side-chat", sourceSessionId: parentSessionId, sourceRevision: copy.revision,
      inheritedThrough: null, createdAt: new Date().toISOString(),
    } satisfies SideChatContext;
    const requestId = `side-chat:${child.id}`;
    // A lost response after Rust commits the copy is recoverable by reading the
    // durable receipt before retrying, so concurrent and restarted opens never
    // copy twice.
    const copied = await runtimeFacade.forkCopyResult(child.id, requestId) ?? await runtimeFacade.cloneHistoryAuthoritative({
      sourceSessionId: parentSessionId, targetSessionId: child.id, fullHistory: true,
      revision: copy.revision, allowSourceChanges: copy.allowSourceChanges,
      requestId, sessionMetadata: copy.metadata,
    });
    // Records at or before this instant belong to the inherited snapshot: they
    // stay available as model context but never enter the side-chat transcript.
    const sideChatContext: SideChatContext = { ...context,
      sourceRevision: copied.sourceRevision ?? copied.revision, inheritedThrough: new Date().toISOString() };
    // Publish readiness only after the snapshot and terminal status are durable.
    // Never inherit primary control metadata.
    const session = await runtimeFacade.sessionPatch(child.id, `side-chat-ready:${child.id}`, {
      status: "completed", activeRunId: null, pendingResumeToken: null, completedAt: null,
      blockedReason: null, resultSummary: null, updatedAt: sideChatContext.createdAt,
      sessionMetadata: { sideChatContext, sideChatReady: true, forkPreparing: false, sideChatCopy: null },
    }) as AgentSession;
    await agentRuntimeStore.hydrateSessionSummary(child.id, true);
    return { session, sideChatContext: readSideChatContext(session) ?? sideChatContext, reused: Boolean(preparing) };
  });
}

/**
 * Read the side chat a primary conversation would reopen. This is a pure
 * lookup, so an affordance that stands for a collapsed side chat never pays for
 * a new snapshot: an absent side chat is a valid answer instead of a creation.
 */
export async function readSideChat(parentSessionId: string) {
  const sessions = await runtimeFacade.listSessionProjection() as AgentSession[];
  const existing = reusableSideChat(sideChatChildren(sessions, parentSessionId));
  if (!existing) return { session: null };
  const session = (await runtimeFacade.uiSnapshotAuthoritative(existing.id)).session as AgentSession;
  return { session };
}

/**
 * Side chats a destroy request must erase. Unlike reopening, discarding targets
 * the whole slot: an archived child and a child that never published readiness
 * both hold a copied snapshot, so leaving either behind would keep the data the
 * user asked to remove. The transport owns the shutdown and purge steps.
 */
export async function listSideChatSessionIds(parentSessionId: string): Promise<string[]> {
  await agentRuntimeStore.hydrateSessionSummary(parentSessionId, true);
  // A hidden primary conversation has no side chat left to discard.
  agentRuntimeStore.getSession(parentSessionId);
  const sessions = await runtimeFacade.listSessionProjection() as AgentSession[];
  return sessions
    .filter(child =>
      child.parentSessionId === parentSessionId && isInteractiveSideChat(child) &&
      !child.sessionMetadata?.deletedAt)
    .map(child => child.id);
}
