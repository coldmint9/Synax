import type {
  ConversationGitSnapshot,
  ConversationGitStateEvent,
} from "../../../../../services/local-node/modules/agent-runtime/conversation-git/contracts";

/** Projection events contain metadata only. Never replace a newer authoritative state. */
export function applyMergeState(
  snapshot: ConversationGitSnapshot,
  event: ConversationGitStateEvent,
): ConversationGitSnapshot {
  if (
    snapshot.task.id !== event.taskId ||
    event.taskRevision < snapshot.task.revision ||
    event.mrVersion < snapshot.mr.version
  )
    return snapshot;
  const current = snapshot.execution;
  if (
    current &&
    event.execution &&
    (event.execution.epoch < current.epoch ||
      (event.execution.epoch === current.epoch &&
        event.execution.revision < current.revision))
  )
    return snapshot;
  return {
    ...snapshot,
    task: { ...snapshot.task, revision: event.taskRevision },
    mr: { ...snapshot.mr, version: event.mrVersion, status: event.status },
    ...(event.execution ? { execution: event.execution } : {}),
    ...(event.files ? { files: event.files } : {}),
  };
}

export function chooseMergeSnapshot(
  current: ConversationGitSnapshot | null,
  incoming: ConversationGitSnapshot,
) {
  if (current && incoming.task.mrId !== current.task.mrId)
    return incoming.task.revision > current.task.revision ? incoming : current;
  if (
    !current ||
    (incoming.task.revision >= current.task.revision &&
      incoming.mr.version >= current.mr.version)
  )
    return incoming;
  return current;
}
