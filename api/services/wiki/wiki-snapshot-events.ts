import { nanoid } from "nanoid";
import { logger } from "../../lib/logger.js";
import {
  taskNotificationBus,
  TaskNotificationEventType,
  type WikiDocumentCommittedNotificationEvent,
  type WikiSnapshotNotificationEvent,
  type WikiSnapshotEventTree,
} from "../notifications/task-notification-bus.js";
import { wikiStore } from "./wiki-store.js";
import { sendToParent } from "../../lib/ipc/child-forward.js";

export const WikiSnapshotEventReason = {
  Connected: "connected",
  DocumentUpdated: "document_updated",
  ProjectPurged: "project_purged",
  DraftApplied: "draft_applied",
  DraftDiscarded: "draft_discarded",
  GenerationStarted: "generation_started",
  OutlineReady: "outline_ready",
  WritingStarted: "writing_started",
  DocumentCommitted: "document_committed",
  GenerationCompleted: "generation_completed",
  GenerationFailed: "generation_failed",
  ContinueStarted: "continue_started",
  ContinueCompleted: "continue_completed",
  ContinueFailed: "continue_failed",
  WritingPaused: "writing_paused",
  DocumentsMarkedStale: "documents_marked_stale",
  RefreshCompleted: "refresh_completed",
  RefreshFailed: "refresh_failed",
} as const;

export type WikiSnapshotEventReason =
  (typeof WikiSnapshotEventReason)[keyof typeof WikiSnapshotEventReason];

export async function getLatestWikiSnapshotTree(projectId: string): Promise<WikiSnapshotEventTree> {
  const snapshot = await wikiStore.getLatestSnapshot(projectId);
  if (!snapshot) {
    return {
      snapshot: null,
      documents: [],
      draftsSummary: { ready: 0, generating: 0 },
    };
  }

  const tree = await wikiStore.getSnapshotTree(snapshot.id);
  return tree ?? {
    snapshot: null,
    documents: [],
    draftsSummary: { ready: 0, generating: 0 },
  };
}

export async function buildWikiSnapshotEvent(
  projectId: string,
  reason?: WikiSnapshotEventReason,
): Promise<WikiSnapshotNotificationEvent> {
  return {
    id: nanoid(12),
    type: TaskNotificationEventType.WikiSnapshot,
    projectId,
    timestamp: Date.now(),
    reason,
    tree: await getLatestWikiSnapshotTree(projectId),
  };
}

export async function publishLatestWikiSnapshot(projectId: string, reason?: WikiSnapshotEventReason): Promise<void> {
  try {
    const event = await buildWikiSnapshotEvent(projectId, reason);
    if (sendToParent({ type: 'ipc:event', event })) return;
    taskNotificationBus.emit(event);
  } catch (err) {
    logger.warn({ err, projectId, reason }, "wiki snapshot event: emit failed");
  }
}

export async function publishDocumentCommittedEvent(projectId: string, documentId: string): Promise<void> {
  try {
    const doc = await wikiStore.getDocument(documentId);
    if (!doc) return;
    const event: WikiDocumentCommittedNotificationEvent = {
      id: nanoid(12),
      type: TaskNotificationEventType.DocumentCommitted,
      projectId,
      timestamp: Date.now(),
      documentId,
      document: doc,
    };
    if (sendToParent({ type: 'ipc:event', event })) return;
    taskNotificationBus.emit(event);
    logger.debug({ projectId, documentId }, 'wiki-snapshot-events: document committed event published');
  } catch (err) {
    logger.warn({ err, projectId, documentId }, "wiki-snapshot-events: document committed event failed");
  }
}
