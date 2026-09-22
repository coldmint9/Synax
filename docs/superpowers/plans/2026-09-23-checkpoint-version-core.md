# Checkpoint version core implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Keep the work local unless a later scoped delegation is explicitly justified by applicable instructions.

**Goal:** Build the durable bounded-resource primitives required to replace history replay with root switching; this phase does not complete the full checkpoint performance objective.

**Architecture:** Immutable typed content-addressed objects in SQLite, a path-copying ordered tree, and transactional session heads with revisions/epochs. Existing runtime is unchanged until all consumers, migration, resource governance and recovery are ready; no partial v3 production enablement.

**Tech Stack:** Existing Node 22, TypeScript, libSQL, Vitest; no new package dependency.

**Spec:** `docs/superpowers/specs/2026-09-23-checkpoint-performance-design.md`

## Global constraints

- `.DS_Store` never enters Git; branch starts from main, no test/beta merges.
- Tests only use independent in-memory or temporary databases; do not write `~/.synax` or replace the installed application.
- Chunk size ≤ 64KiB; tree node ≤ 16KiB; page ≤ 256 rows and ≤ 1MiB; cache ≤ 32MiB.
- Never load whole history, reconstruct an entire branch on read, or recursively clean history when switching a head.
- All acknowledged objects precede root publication durably; do not relax SQLite synchronous guarantees for benchmark numbers.
- API latency p95 ≤ 1s / p99 ≤ 2s, RSS and physical-storage acceptance remain pending end-to-end gates, not claims made by core unit tests.

## File map

Create under `api/services/agent-runtime/checkpoints/version-store/`:
- `limits.ts`: byte/count limits and typed resource/corruption/conflict errors.
- `transaction.ts`: short synchronous nested transaction boundary (savepoint inside caller transaction, IMMEDIATE outside).
- `objects.ts`: typed hashing, read/write integrity, explicit reference edges, quota admission and bounded retrieval.
- `tree-nodes.ts`: bounded node codec, structural validation and byte-aware node splitting.
- `tree.ts`: immutable ordered map from bounded keys to content references; sorted incremental updates, keyset pagination and sharing.
- `versions.ts`: typed root manifests with validated tree references.
- `heads.ts`: minimal immutable root versions, per-session head CAS and operation idempotency, metadata-only forks.

Create SQL migration `api/db/migrations/0051_conversation_version_core.sql` after rechecking migration numbering.

Create tests under `api/services/agent-runtime/__tests__/`:
- `version-store-fixture.ts`: owns isolated databases, applies the real migration, closes/removes fixtures.
- `checkpoint-version-objects.test.ts`
- `checkpoint-version-tree.test.ts`
- `checkpoint-version-heads.test.ts`

## Task 1 — Immutable object store and quota admission

**Interfaces:**
- `VersionObjects(db, { maxBytes, maxObjects })` requires an explicit logical quota (physical DB/WAL guard is a later layer).
- `put(kind, bytes, references?): string` returns a typed content hash, idempotently.
- `get(hash, expectedKind?): { kind, bytes, references }` reads one bounded object and verifies its identity.
- `stats(): { objects, bytes }` is O(1) using transactional counters, never COUNT over history.
- `atomicVersionWrite(db, action)` supports nested rollback and rejects asynchronous callbacks.

- [x] Write tests for dedup, kind/reference identity, mutation-safe returned data, missing/corrupt payload, oversized payload/reference list, quota rollback, nesting and disk reopen.
- [x] Run `node node_modules/vitest/vitest.mjs run api/services/agent-runtime/__tests__/checkpoint-version-objects.test.ts`; observe missing-module/failing behavior before implementation.
- [x] Implement the migration and minimal store; SQL constraints mirror ingress limits; retrieval checks length before materializing payload.
- [x] Run the suite again; test a quota failure leaves both counters and object rows unchanged.
- [x] Commit the passing implementation and tests (explicit paths only).

## Task 2 — Bounded persistent ordered tree

**Interfaces:**
- `VersionTree(objects)` is stateless across requests.
- `update(root: string | null, changes: readonly { key: string; value: string | null }[]): string | null` copies changed paths for a bounded sorted batch (collapsed intermediate roots may leave bounded garbage for the GC phase); null value deletes a key.
- `get(root, key): string | undefined` performs bounded-depth lookup.
- `page(root, { after?, limit?, maxBytes? }): { entries, next? }` fixes the root across pages and uses an exclusive key cursor, not SQL OFFSET or ancestor replay.
- `size(root): number` reads cached subtree counts from bounded root data.

- [x] Tests: literal insertion/update/delete, stable old roots, forks sharing content, multi-level split, huge-key rejection, max batch rejection, exact cursor pagination, randomized operations against a Map oracle, no missing/duplicate keys after deletion.
- [x] Confirm RED with the command targeting `checkpoint-version-tree.test.ts`.
- [x] Implement byte-bounded node codec and sorted batch path copying, bounded-depth validation; avoid cloning one path for every token.
- [x] Verify shared untouched subtrees and allocation/read counts with actual database rows and prepared-statement spies that still execute real SQL.
- [x] Re-run objects + tree tests and commit.

## Task 3 — Atomic head switches, epochs and idempotency

**Interfaces:**
- `VersionHeads(db, objects)` shares the same connection as objects.
- `create(sessionId, rootVersionId)` creates an independent control identity.
- `read(sessionId): { versionId, revision, epoch }` reads one head.
- `publish({sessionId, versionId, expectedRevision, expectedEpoch})` is the trusted writer API: validates the writer generation, registers version ownership and advances the head without restoring an old execution epoch.
- `switch({sessionId, targetVersionId, expectedRevision, requestId, requestHash})` atomically changes a root, increments epoch/revision, stores result, and never iterates objects.
- `fork({sourceSessionId, targetSessionId, versionId, expectedRevision, requestId, requestHash})` records an independent head and stable idempotent result; no data copy.

- [ ] Tests: exact repeat result, conflicting request hash, stale revision, root integrity/missing root, independent forks, outer transaction rollback, reopening after committed switch, no data writes proportional to history.
- [ ] Confirm RED before implementing `heads.ts`.
- [ ] Implement small transactions; target must be a version object, CAS updates and operation result commit together.
- [ ] Verify wrong-session references cannot bypass ownership via arbitrary supplied object hashes (repository authorization/root pin layer must be explicit; no public API exposed yet).
- [ ] Run all three test suites and commit.

## Task 4 — Core performance evidence and scope audit

- [ ] Create isolated benchmark coverage for key counts that cross several node levels, repeated root switches and forks, bounded pages, dedup and quota boundaries.
- [ ] Record elapsed time, object/node counts, DB/WAL size and RSS separately; avoid a timing-only brittle unit-test assertion.
- [ ] Run `node node_modules/typescript/bin/tsc --noEmit` and relevant existing checkpoint tests using isolated environment configuration.
- [ ] Inspect production call sites to verify v3 has NOT been partially enabled; update task status and document remaining integration gaps.

## Subsequent plans required before full completion

1. Runtime writer/reader integration, existing control-plane leases, child-session ownership, context/search/export/usage, API/renderer pagination, immutable content chunking with bounded input queues.
2. Bounded file-difference plans, preserved Git/external-write boundaries, durable compensation and fenced execution.
3. Shared global memory/disk accounting, reference pins, incremental concurrent-safe GC, WAL budgets, worker scheduling and cancellation/recovery semantics.
4. Per-session v2→v3 conversion including old checkpoint semantics, compatibility lock and recoverable disk-full handling.
5. End-to-end 10k/100k/1M event runs, 1k checkpoints/branches, 10k-operation soak, native memory and physical storage budgets, crash/ENOSPC/race tests.

Each subsequent plan must keep the parent objective and all specification gates; the current core is not a substitute deliverable.

## Execution evidence

- 2026-09-23 Task 1: observed RED for missing objects module, then 11 real-libSQL tests PASS; `tsc --noEmit` PASS. Logical quota accounting is not yet a physical disk/WAL guard, and no production session uses v3.
- 2026-09-23 Task 2: observed missing-module RED and empty-page-budget RED, then 22 tests PASS across objects/tree; `tsc --noEmit` PASS. 6,000-key multi-level fixture verifies bounded reads/path-copy allocation. Not an end-to-end latency/memory/storage acceptance result.
