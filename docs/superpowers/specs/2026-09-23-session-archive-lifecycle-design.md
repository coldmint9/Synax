# Session Archive Lifecycle Design

## Overview

Synax currently exposes session deletion as a destructive operation: deleting a session stops active work and removes the session tree together with its messages, events, steps, artifacts, and history. This design replaces every user-facing session deletion entry point with a reversible archive lifecycle. Archived sessions disappear from normal session views and runtime APIs, while a new global settings area lets users restore them or permanently delete them. A configurable global retention policy permanently deletes old archive batches after seven days by default.

The lifecycle applies to agent workspace sessions, workflow sessions, and child sessions managed by the agent runtime. It does not change the separate context-memory session model.

## Goals

- Replace single-session deletion and bulk inactive-session deletion with archive operations.
- Preserve session data and hierarchy while an archive is retained.
- Make archived sessions and all referenced runtime data unavailable through normal APIs.
- Allow archive batches to be restored from global settings.
- Allow explicit, irreversible deletion of an archive batch.
- Automatically delete expired archive batches using a configurable global retention period.
- Preserve existing safe shutdown behavior before archiving a running session.
- Update all icons, labels, dialogs, notifications, and accessibility text to archive semantics.

## Non-goals

- Showing archived sessions in the normal session or workflow lists.
- Supporting per-project retention overrides.
- Supporting bulk selection, bulk restore, or bulk permanent deletion in the first release.
- Restoring sessions that were physically deleted before this feature exists.
- Changing the lifecycle of context-memory sessions or archived projects.

## Data Model

A migration adds the following nullable columns to `agent_runtime_sessions`:

```sql
archived_at TEXT NULL,
archive_batch_id TEXT NULL
```

It also adds an index suitable for archive listing and retention scans:

```sql
CREATE INDEX ... ON agent_runtime_sessions(archived_at, archive_batch_id);
```

`archived_at IS NULL` identifies a normal session. An archived session has both fields populated. Every member of one recursive archive operation receives the same timestamp and batch identifier.

The batch identifier is the ID of the session selected as the archive root. This makes the identifier stable and avoids introducing a separate archive entity. Re-archiving a restored tree may reuse the same batch identifier because only one current archive batch can own that root.

The existing runtime `status` is not changed to `archived`. The status continues to describe the session's execution outcome, such as `completed`, `failed`, or `interrupted`. Running sessions are safely interrupted before the archive transaction, so a restored session never resumes an execution that was active before archival.

Messages, events, runs, steps, permissions, artifacts, checkpoints, context bundles, assets, and parent/child identifiers remain stored while the archive exists.

The global configuration gains:

```ts
sessionArchiveRetentionDays: number | null
```

The default is `7`. A positive integer from 1 through 3650 enables automatic cleanup after that many days. `null` disables automatic cleanup. Changing the value changes only the cutoff calculation; it does not rewrite existing archive timestamps.

## Archive Batch Semantics

An archive operation acts on the selected session and its complete descendant tree.

1. Resolve the tree, including descendants that may already belong to an older child archive batch.
2. Safely interrupt every active session in the tree and wait for shutdown confirmation.
3. Re-read the tree after shutdown to avoid archiving a stale topology.
4. In one database transaction, write the same `archived_at` and `archive_batch_id` to every member.
5. Emit lifecycle events and invalidate runtime/UI resources only after the transaction succeeds.

If a child subtree was archived independently and its active parent is later archived, the parent operation absorbs that child subtree into the parent's new batch. This prevents overlapping archive batches and ensures that every batch can be restored as a coherent tree.

A repeated archive request for the same already archived root is idempotent: it returns the existing batch without changing its archive timestamp. Normal session routes still treat that session as absent.

## Visibility Boundary

Normal runtime behavior is restricted to sessions whose `archived_at` is `NULL`. This predicate must apply to:

- Session retrieval and optional retrieval.
- Session list paging, status counts, and badges.
- Session tree traversal.
- Full-text session search and snippets.
- Session detail, messages, events, steps, history windows, interactions, permissions, artifacts, and usage endpoints.
- Child-session and subagent controls.
- Background-process and live-stream operations.
- Runtime recovery, pending-interaction scans, checkpoint bootstrap, and other direct SQL readers.

Archive management uses dedicated store methods that intentionally read archived rows. Normal code must not opt into archived reads through an optional flag because that would make accidental exposure easier.

When a normal endpoint is given an archived session ID, it returns the same not-found response used for an unknown session. Referenced rows may remain in their tables, but they cannot be reached through their normal session-scoped API because the parent visibility guard fails first.

All direct reads of `agent_runtime_sessions` outside the central store require an audit. Operational and recovery queries must add the active-session predicate. Physical-deletion and archive-management queries are the explicit exceptions.

The full-text index may retain text for an archived session, but search queries must join the session table and require an active session. Restoring the session therefore makes existing indexed text searchable again without rebuilding its history.

## API Design

### Archive one session tree

```http
POST /api/agent-runtime/sessions/:sessionId/archive
```

The request accepts the existing optional run-control identifier used during safe shutdown. The response is:

```ts
{
  ok: true;
  archiveBatchId: string;
  archivedAt: string;
  archivedSessionIds: string[];
}
```

The existing endpoint remains as a compatibility alias during this release:

```http
DELETE /api/agent-runtime/sessions/:sessionId
```

It performs the same archive operation and never physically deletes data. The web client uses the new `POST` endpoint.

### Archive inactive sessions

```http
POST /api/agent-runtime/sessions/archive-inactive
```

The body contains `projectId`. The operation considers only active, non-running roots without runtime-control metadata or active processes. Each root and its descendants become a separate archive batch. The response reports both batch and session counts.

The old `clear-inactive` client operation is replaced rather than retained as a hard-delete path.

### List archives

```http
GET /api/agent-runtime/session-archives
```

Supported query parameters:

- `projectId` for optional project filtering.
- `q` for title and prompt search.
- `limit` and `offset` for pagination.

Results are sorted by archive time descending. Each result represents one archive batch root and includes:

```ts
{
  archiveBatchId: string;
  rootSessionId: string;
  title: string | null;
  prompt: string;
  projectId: string;
  archivedAt: string;
  sessionCount: number;
  scheduledDeletionAt: string | null;
}
```

The response also includes `totalCount`. `scheduledDeletionAt` is `null` when automatic cleanup is disabled.

### Restore an archive batch

```http
POST /api/agent-runtime/session-archives/:batchId/restore
```

The store validates that the batch exists and is internally consistent, then clears `archived_at` and `archive_batch_id` for the complete batch in one transaction. It preserves runtime data and hierarchy. It sets `updated_at` to the restore time so the restored root returns to the recent-session area. The response returns the restored session IDs.

### Permanently delete an archive batch

```http
DELETE /api/agent-runtime/session-archives/:batchId
```

Only a complete archived batch is accepted. Active sessions cannot be permanently deleted through this endpoint. The operation immediately tombstones or removes the batch from archive listings, then uses the existing resumable history deletion machinery to remove runtime records and large version history safely. It returns the accepted session IDs and does not imply that every storage cleanup phase finished synchronously.

Manual permanent deletion and retention cleanup call the same internal purge service.

## Service Boundaries

The implementation should separate four responsibilities:

1. **Active session store** — reads and mutates only non-archived sessions for normal runtime use.
2. **Archive store/service** — lists archive batches, archives trees, restores batches, and calculates retention metadata.
3. **Permanent deletion service** — accepts only archived batches and drives the existing physical cleanup pipeline.
4. **Retention coordinator** — reads global policy, finds expired batches, serializes cleanup runs, and invokes permanent deletion.

These boundaries prevent ordinary runtime code from casually reading archives and keep permanent deletion out of user-facing archive operations.

## Automatic Retention

The retention coordinator runs:

- Once after the API process starts and database migrations/configuration are available.
- Once every 24 hours while the API process remains alive.
- Once immediately after the retention setting changes.

If the application is closed when a batch expires, the next startup run deletes it. Expiration is calculated from `archived_at` using whole timestamps: a batch is eligible when its archive time is less than or equal to `now - retentionDays`.

A process-local mutex prevents startup, timer, and configuration-triggered scans from overlapping. Each batch is purged independently so one failure does not block later eligible batches. Failures are logged and retried on the next scan. The interval must be released during server shutdown and must not keep tests or CLI processes alive unintentionally.

When retention is disabled, the coordinator performs no scan and the settings UI states that archives remain until manually deleted.

## User Interface

### Session actions

Every user-facing session delete action becomes an archive action:

- Replace `Trash2` with Lucide `Archive`.
- Replace “Delete”/“删除” with “Archive”/“归档”.
- Remove red danger styling from archive actions and confirmation buttons.
- Use an archive-specific pending state and failure notification.

The confirmation copy is:

> 归档「{title}」及其所有子会话？归档后不会显示在会话列表和搜索结果中，可前往“设置 → 会话归档”恢复。

English:

> Archive “{title}” and all of its child sessions? Archived sessions disappear from session lists and search results, and can be restored from Settings → Session Archive.

When any member is active, the dialog additionally explains that archival will interrupt the current run.

A successful archive removes affected sessions from local stores, detail caches, recent-visit state, live subscriptions, and selected routes using the current removal behavior. The naming of local methods should change from deletion to archive/removal semantics where practical.

### Archive inactive sessions

The current clear-inactive action becomes “Archive inactive sessions” with the `Archive` icon. Its confirmation states that all non-running sessions in the current project will be archived and can be restored from settings. It must not use irreversible-deletion language or destructive styling.

### Global Session Archive settings page

Add a dedicated `Session Archive` item to the global settings navigation. The page is global across projects.

The top settings card contains:

- An “Automatically clean up archived sessions” switch, enabled by default.
- A number input shown while enabled, defaulting to 7 days and accepting integers from 1 through 3650.
- Explanatory text when disabled: archived sessions are retained until manually permanently deleted.

The archive list provides:

- Search by title or original prompt.
- Project filter.
- Root title and project.
- Archive timestamp.
- Number of sessions in the batch.
- Scheduled deletion timestamp, or an “Automatic cleanup disabled” label.
- Loading, empty, pagination, and error states.

Each row has:

- **Restore**, using `ArchiveRestore`, with a non-destructive loading state and success notification.
- **Permanently delete**, using red `Trash2`, which always opens a destructive confirmation dialog.

Permanent deletion confirmation states:

> 彻底删除「{title}」及其归档批次中的 {count} 个会话？相关消息、步骤、事件、历史和产物将永久删除，此操作不可撤销。

English:

> Permanently delete “{title}” and the {count} sessions in its archive batch? Their messages, steps, events, history, and artifacts will be permanently removed. This cannot be undone.

The first release does not include multi-select or bulk manual actions.

## Internationalization and Accessibility

All new labels, descriptions, confirmation messages, pending states, success notifications, failure notifications, empty states, and accessibility labels are added to both Chinese and English localization dictionaries.

Icon-only controls require localized accessible names. Dialog focus behavior and keyboard dismissal follow the existing HeroUI modal patterns. Destructive styling is reserved exclusively for permanent deletion.

## Error Handling and Concurrency

- If safe interruption fails, no archive fields are written and the session remains visible.
- Archive and restore writes are transactional across the entire batch.
- The tree is re-read after shutdown to avoid applying stale membership.
- Restoring and permanently deleting the same batch concurrently allows only one transaction to win. The loser re-reads state and returns a clear conflict/not-found response.
- Permanent deletion is rejected for active or partially archived data.
- Once a permanent-deletion tombstone is accepted, the batch remains invisible even if later physical cleanup phases fail.
- Invalid retention values are rejected by frontend validation and backend schema validation.
- Archive-list failures stay local to the settings page and do not affect normal session operation.

## Migration and Compatibility

The migration is additive and non-destructive. Existing rows have `NULL` archive fields and remain active. Existing physical-deletion tombstones remain governed by the current cleanup pipeline and do not become restorable archives.

The old HTTP delete endpoint archives for compatibility, ensuring that an older renderer cannot bypass the new lifecycle. Permanent deletion has a new archive-only route and is never inferred from the old endpoint.

No package version is changed as part of feature development. The project versioning rule applies only when preparing a push to `main`.

## Testing Strategy

### Database and store tests

- The migration preserves and exposes pre-existing sessions as active.
- Creating and updating active sessions leaves archive fields null.
- Archiving one session writes both lifecycle fields.
- Archiving a parent applies one batch to all descendants.
- A parent archive absorbs an independently archived child batch.
- Archive and restore transactions roll back completely on injected failure.
- Active getters, lists, counts, badges, tree traversal, and direct operational readers exclude archived sessions.
- Archive store methods return only archived batches.
- Restore preserves messages, events, runs, steps, artifacts, checkpoints, and relationships.
- Permanent deletion accepts only archived complete batches and clears all referenced data through the existing deletion pipeline.

### Search and API tests

- Archived titles, prompts, and messages do not appear in search.
- Restored sessions become searchable without rebuilding unrelated history.
- Normal detail and referenced-data endpoints return not found for archived IDs.
- The new archive, bulk archive, list, restore, and permanent-delete routes validate inputs and return the documented payloads.
- The legacy `DELETE /sessions/:id` archives and never physically deletes.
- Project filtering, archive search, pagination, and total counts are correct.

### Retention tests

- The default policy is seven days.
- Custom values from 1 through 3650 are accepted.
- Null disables automatic cleanup.
- Cutoff boundaries use the archive timestamp correctly.
- Startup, interval, and configuration-triggered scans share one mutex.
- One failed batch does not block other expired batches and is retried later.

### Frontend tests

- Session menu, bulk action, icons, dialog copy, and styling use archive semantics.
- Running sessions show the interruption warning.
- Successful archival clears routes, last-visit state, caches, subscriptions, and affected local sessions.
- Global archive settings load, search, filter, paginate, restore, and permanently delete batches.
- Permanent deletion always requires confirmation.
- Retention toggle and day validation persist through the global config API.
- Chinese and English content and accessibility labels render correctly.

### Regression checks

- Run focused API and web Vitest suites.
- Run root and web TypeScript checks.
- Run the web production build.
- Confirm `.DS_Store` remains untracked.
- Keep unrelated existing workspace edits out of the feature commits.

## Acceptance Criteria

- No user-facing session action physically deletes an active session.
- Archived sessions disappear from all normal lists, searches, detail routes, and referenced-data APIs immediately.
- A complete archive batch can be restored with its data and hierarchy intact.
- Only archived batches can be permanently deleted.
- Automatic cleanup defaults to seven days, accepts a global custom day count, and can be disabled.
- The global settings page provides archive discovery, restore, permanent deletion, and retention configuration.
- All archive actions use archive icons and reversible-language prompts; only permanent deletion uses trash icons and destructive language.
