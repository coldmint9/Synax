# Versioned transcript runtime bridge verification

Local run date: 2026-09-23, Asia/Shanghai. The overall checkpoint performance goal remains ACTIVE / INCOMPLETE.

## What is now connected

- The real `AgentRuntimeStore` dispatches explicitly initialized transcript-cohort message/event writes and reads to immutable records, rather than mirroring them into the mutable runtime message/event tables.
- Direct session lookup and session-list mapping overlay historical prompt/result/context/metadata from the current root. Current permissions and volatile control metadata remain outside the rewindable projection.
- Real checkpoint capture, preview and rollback functions/routes dispatch to a persistent checkpoint index. Rollback replaces the session root and checkpoint-index prefix atomically; it does not enumerate/delete future messages/events/checkpoints.
- Message and event routes provide bounded pages and revision-bound cursors. Large text uses separate content pages; continuation without the original revision is rejected.
- Type-specific event indexes support latest-event and count-after queries through tree rank/last operations rather than full event materialization.
- Stream history fences distinguish write revision from execution epoch; ordinary v3 publication does not invalidate its own stream generation.
- A short synchronous read transaction covers a whole returned page. A real two-connection test switches/collects the prior root while another connection reads; the read returns one coherent old snapshot and the next read sees the new version.

## Rollout restriction — not a substitute final state

There is NO automatic/public enablement. Normal sessions remain v2. Only an explicit internal initializer accepts a fresh inactive native root transcript, and it rechecks persisted active state inside its transaction. Schema guards reject unported mutable row writes and child creation for that cohort. Run admission rejects it before any execution is accepted. Edit/resend, fork, file restoration, assets, existing-data migration and background runtime consumers are not integrated.

This restriction prevents a misleading partially successful rollback while work continues. It does NOT satisfy the user's complete requested end state. The installed Synax app and real user DATA_ROOT remain untouched.

## New storage/read mechanisms

- `VersionText` persists text in <=64KiB JSON-encoded chunks with a bounded tree manifest; it preserves valid Unicode pairs and lone surrogate JSON semantics. Current in-memory ingestion cap is 16MiB per text field, not an unlimited streaming-ingestion implementation.
- `RuntimeRecordCodec` keeps <=16KiB headers, externalizes large strings/JSON, and checks size/depth/node budgets before whole metadata serialization. Explicit projections and content paging prevent small list responses from loading multi-megabyte content.
- Table manifests reference ID/order indexes and incremental counts. Message replacement removes the previous ordered entry without rewriting unrelated records.
- A second strong root on the session head pins its visible checkpoint-index tree. Checkpoint identities include monotonic ordinals and a nonce, allowing logarithmic lookup directly in that tree; no extra weak locator table was needed for the current same-session transcript scope.
- Prefix truncation, rank and last-entry navigation are covered by structural read/allocation bounds and correctness assertions.
- Root/index/idempotency writes use the same transaction. A repeated rollback returns its committed result even when the original checkpoint has been trimmed/collected.

## Actual route-scale probe

The isolated test uses the real session creator, `AgentRuntimeStore.appendEvent`, checkpoint capture and Hono rollback route with 10,000 events. Maintenance is explicitly driven by the test harness, not by a production scheduler.

Archived single-run result (`2026-09-23-checkpoint-runtime-scale.json`):

- Rollback response: HTTP 200.
- Elapsed rollback route time: 6.489ms (ONE warm sample, not p95/p99 or cold-start acceptance).
- Immutable object reads during rollback: 13 (test limit <100).
- Messages restored to the pre-checkpoint transcript; post-checkpoint thought events excluded.
- No session rows inserted into the legacy undo journal.
- Observed end-of-run RSS: 248,283,136 bytes (~236.8MiB); heapUsed: 155,121,440 bytes (~147.9MiB). These are snapshots of a test worker importing the application, NOT sampled peak RSS or production memory guarantees.
- Fixture construction + explicit maintenance took about 71 seconds. Per-event publication and production writer throughput are not yet optimized; this is a newly visible performance risk, not evidence of fast ingestion.

The final 22-file regression reran this scale test successfully. Its timing assertion intentionally checks structure/correctness rather than a flaky millisecond threshold; raw timings are observations.

## Verification

- Final isolated DATA_ROOT run: **22 files / 138 tests PASS** (81.14 seconds).
- Includes new text/record tests, repository/route integration, two-connection read/GC race, all prior core/pin/GC/transaction safety tests, existing file checkpoint/recovery/route behavior, DB migrations, execution context and benchmark/soak CLI tests.
- API `tsc --noEmit` PASS; standalone benchmark/soak typecheck PASS.
- `git diff --check` PASS.
- No real database reset or installed-app replacement performed.

## Remaining work / critical next steps

1. Batch runtime publication (especially delta/event writes) and schedule bounded GC outside API work. The 10k fixture build time means per-event immutable publication cannot be presented as the finished high-throughput solution.
2. Integrate runs, steps, parts, tools, permissions/history views, interactions, work, contexts, assets and child-session scopes. Separate live control/actual usage from historical projections; then remove the temporary transcript execution guard.
3. Implement edit/resend and fork with root ownership, current authorization and file/process fences; port every direct SQL consumer, search/snippets, context, exports and statistics.
4. Complete checkpoint lifecycle details: capture deduplication, latest reply lookup, summary pagination/client consumption, deletion/recovery of cohort sessions and checkpoint metadata policies. Current capture allocates a new checkpoint on repeated capture, unlike legacy idempotent capture.
5. Add frontend cursor/projection/content support and bounded IPC/worker queues. Current frontend assumes full list responses and defaults file inclusion, so the new cohort is intentionally not user-enabled.
6. File manifest differences, shared-workspace/Git/conflict preservation, durable compensation and interruption recovery remain on the legacy path.
7. Old v2 history/checkpoint migration, application downgrade protection and production physical disk/WAL/temp admission remain incomplete. Current object/metadata quotas are logical counters, not a total physical disk cap.
8. End-to-end cold/concurrent million-event API/UI, OOM/physical-storage steady state, crash/ENOSPC and long-running production-like tests remain required. Previous core benchmarks do not prove these gates.
