# Versioned history runtime bridge implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task.

**Goal:** Start replacing actual AgentRuntimeStore/history endpoint behavior with the version engine, not another standalone benchmark. Keep the full native-runtime, files, migration, UI and resource objective open.

**Architecture:** A bounded value/record codec stores large text in chunk trees and small row headers in immutable objects. A session-scoped repository publishes message indexes and historical session fields into version roots. A persistent checkpoint index is a second strong head root; prefix truncation drops future checkpoints without deleting them synchronously. An explicitly initialized, non-default test cohort exercises real store/routes before unsupported runtime consumers are ported.

**Tech Stack:** Existing TypeScript, libSQL, Hono, Vitest. No new dependency.

**Spec:** `docs/superpowers/specs/2026-09-23-checkpoint-performance-design.md`

## Constraints

- Never activate v3 automatically for existing/normal sessions in this phase.
- Reject unsupported operations in the experimental cohort instead of silently restoring only messages when other historical state exists.
- Writes, object construction and head/checkpoint-root publication share one short synchronous transaction; no await or unpinned intermediate state.
- Raw text is chunked at <=64KiB. Read/materialization budgets are checked before joining content; large content has a bounded range/stream interface.
- Checkpoint publication and root switching never enumerate messages/checkpoints or synchronously delete abandoned objects.
- Version revision changes on ordinary writes; execution epoch changes only on history replacement. Stream writers must use the latter.
- Keep permissions and live process/control state authoritative; do not restore obsolete execution leases.
- Stable request IDs, stale-preview checks, active writer/process fences and file recovery protections remain mandatory.
- Only isolated DATA_ROOT fixtures are used. No installed app or real database writes; no test/beta merges; no `.DS_Store` tracked.

## Task 1 — Bounded text and row codecs

Create `version-store/text.ts`, `version-runtime/record-codec.ts`, and tests.

Interfaces:
- `VersionText.write(text): string`, `info(ref)`, `page(ref, cursor?)`, `read(ref,maxBytes)`; text manifests carry raw and JSON-encoded sizes, code-point-safe chunks and an indexed chunk root.
- `RuntimeRecordCodec.write(table,scope,id,order,fields): string`, `header(ref)`, `read(ref,byteBudget,fields?)`; inline small values, externalize large strings/JSON, preserve exact value semantics and enforce finite node/depth/byte budgets before serialization.

- [ ] RED tests for multi-chunk Unicode round trips, pre-materialization byte rejection, bounded chunk pages, dedup, corrupted descriptors, record projection and large message content.
- [ ] Implement bounded codecs, without whole-string UTF-8 copies or whole-history arrays.
- [ ] Verify real SQLite tests and typecheck.

## Task 2 — Persistent checkpoint index and weak identity metadata

Add a migration for `checkpoint_root` on heads and bounded weak checkpoint/record locators; extend collector cleanup under its shared metadata-row budget. Add prefix truncation to VersionTree and a transactional optional checkpoint-root change to head switch/fork.

- [ ] RED tests for logarithmic prefix truncation, unchanged old roots, checkpoint pinning via index root, stable locator lookup and atomic head/index/idempotency publication.
- [ ] Verify weak metadata does not pin discarded branches, GC handles locator fanout in pages, and metadata quotas include new rows.
- [ ] Use one core migration filename manifest in isolated fixtures and probes rather than updating scattered hardcoded lists.

## Task 3 — Real session-store message/session bridge

Create `version-runtime/repository.ts` and `version-runtime/bridge.ts`; integrate message append/get/list/page and historical session fields into AgentRuntimeStore.

- [ ] Explicit initializer only for a fresh inactive native root session; no public/default feature switch yet.
- [ ] RED tests through real AgentRuntimeStore: writes avoid the mutable message table, ordering/replacement are exact, old versions remain visible through fixed views, and large history requires pagination rather than silent truncation.
- [ ] Keep current permissions and execution control outside historical session projections; preserve volatile metadata instead of copying it into every snapshot.
- [ ] Checkpoint payload v3 can carry common boundary metadata for compatibility, but must never be sent to the old undo replay implementation.

## Task 4 — Capture / preview / rollback and bounded endpoints

Integrate dispatch in checkpoint store/operations, separate history epoch from revision in stream fences, and add version-fixed paged messages/content endpoints.

- [ ] RED real-route tests for checkpoint/preview/rollback, request retries, stale preview, future-checkpoint exclusion, new branch writes, active-run rejection and large content paging.
- [ ] No-file transcript cohort initially rejects edit/run/fork/file operations until their real consumers are integrated. This is a temporary rollout guard, not a replacement scope or a completion claim.
- [ ] Verify no full message/checkpoint scan or old undo DELETE is issued by the v3 rollback path.
- [ ] Run all prior core, DB safety, conversation/file/recovery/route regressions.

## Subsequent required integration

Port all runtime row types and direct SQL consumers (context/search/export/usage/control/children), execution admission/edit-resend/fork scopes, chunked event replay, reader pins/worker scheduling, frontend paging, file plans/compensation, resumable old data conversion and physical disk/WAL/temp admission. Do not enable v3 by default or mark the overall goal complete until those requirements and end-to-end cold/concurrent/large-data tests pass.
