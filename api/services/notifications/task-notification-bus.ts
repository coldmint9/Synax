import { EventEmitter } from "node:events";
import { SseEventType } from "../../lib/sse-events.js";
import type {
  WikiBlock,
  WikiDocument,
  WikiSnapshot,
  WikiSourceBinding,
} from "../wiki/contracts.js";
import type { WikiSnapshotEventReason } from "../wiki/wiki-snapshot-events.js";

export const TaskNotificationEventType = {
  TaskStarted: "task_started",
  TaskProgress: "task_progress",
  TaskCompleted: "task_completed",
  TaskFailed: "task_failed",
  WikiSnapshot: "wiki_snapshot",
  DocumentCommitted: "document_committed",
} as const;

export const NotificationStreamEventType = {
  Connected: SseEventType.Connected,
  Ping: SseEventType.Ping,
} as const;

export type TaskLifecycleNotificationType =
  | typeof TaskNotificationEventType.TaskStarted
  | typeof TaskNotificationEventType.TaskProgress
  | typeof TaskNotificationEventType.TaskCompleted
  | typeof TaskNotificationEventType.TaskFailed;

export type TaskNotificationType =
  | TaskLifecycleNotificationType
  | typeof TaskNotificationEventType.WikiSnapshot
  | typeof TaskNotificationEventType.DocumentCommitted;

export interface TaskLifecycleNotificationEvent {
  id: string;
  type: TaskLifecycleNotificationType;
  taskKind: string;
  projectId: string;
  taskId: string;
  title: string;
  message: string;
  severity: "info" | "success" | "warning" | "error";
  timestamp: number;
  meta?: Record<string, unknown>;
}

export interface WikiSnapshotEventTree {
  snapshot: WikiSnapshot | null;
  documents: WikiDocument[];
  blocks: WikiBlock[];
  sourceBindings: WikiSourceBinding[];
  patchesSummary: { pending: number; conflict: number };
  draftsSummary: { ready: number; generating: number };
}

export interface WikiSnapshotNotificationEvent {
  id: string;
  type: typeof TaskNotificationEventType.WikiSnapshot;
  projectId: string;
  timestamp: number;
  reason?: WikiSnapshotEventReason;
  tree: WikiSnapshotEventTree;
}

export interface WikiDocumentCommittedNotificationEvent {
  id: string;
  type: typeof TaskNotificationEventType.DocumentCommitted;
  projectId: string;
  timestamp: number;
  documentId: string;
  document: WikiDocument;
  blocks: WikiBlock[];
}

export type TaskNotificationEvent = TaskLifecycleNotificationEvent | WikiSnapshotNotificationEvent | WikiDocumentCommittedNotificationEvent;

class TaskNotificationBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(event: TaskNotificationEvent): void {
    this.emitter.emit(`project:${event.projectId}`, event);
    this.emitter.emit("*", event);
  }

  subscribe(
    projectId: string,
    handler: (event: TaskNotificationEvent) => void,
  ): () => void {
    const channel = `project:${projectId}`;
    this.emitter.on(channel, handler);
    return () => {
      this.emitter.off(channel, handler);
    };
  }

  subscribeAll(
    handler: (event: TaskNotificationEvent) => void,
  ): () => void {
    this.emitter.on("*", handler);
    return () => {
      this.emitter.off("*", handler);
    };
  }
}

export const taskNotificationBus = new TaskNotificationBus();
