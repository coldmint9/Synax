# Compact checkpoint references and bounded GC implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task; no production enablement in this phase.

**Goal:** Remove measured reference/index amplification and implement safe incremental reclamation and metadata admission, without narrowing the overall runtime/file/migration/performance objective.

**Architecture:** Binary 32-byte IDs in SQLite; one bounded sorted reference blob per immutable object instead of a two-index edge table. New objects can reference only pre-existing objects, so their graph is a DAG: durable reference counts and an indexed zero-reference work queue replace full mark/sweep. Heads and explicit pins are strong roots; ownership proofs and idempotency results are not roots. All changes and root transfers are transactional.

**Tech Stack:** Existing Node 22, TypeScript, libSQL, Vitest; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-23-checkpoint-performance-design.md`, amended by the measured storage decision below.

## Decision update from evidence

The initial mark/sweep proposal is replaced for the immutable DAG only. Object creation checks existing children before inserting the parent, hashes include all references, and published immutable object references cannot change. Ref-count updates therefore cannot form cycles, and collection can process only unreachable candidates without traversing the entire live history. Future mutable cross-object links must not be added to this DAG without revisiting this invariant.

The 100k diagnostic shows 45,375,488 bytes in edge table + reverse edge index. Compact adjacency removes those structures rather than merely shrinking their entries. Tree payloads refer to positions in their reference list instead of repeating 64-character hashes.

## Global constraints

- Chunks ≤64KiB; nodes ≤16KiB; references ≤256 per object; pages ≤256 rows / 1MiB.
- No real user DB or installed app changes. Branch remains based on main; never track `.DS_Store`.
- No synchronous recursive deletion. Each GC call has object/edge/byte/ownership-row/time budgets, and yields between calls.
- Read-only views must pin their version across short DB transactions. A checkpoint pin does not expire by wall-clock guess; dead-owner cleanup requires separate confirmed lifecycle evidence.
- Metadata admission is finite and transactional. Logical counters are not misrepresented as a physical DB/WAL cap.
- Existing runtime v2 is unchanged. The experimental non-empty v3 prototype is guarded against destructive automatic conversion; its empty-table migration is safe for supported production v2 databases.

## Task 1 — Compact schema, object references and tree encoding

**Files:** Add `api/db/migrations/0053_conversation_compact_versions.sql`; add `version-store/hash-codec.ts`; change `objects.ts`, `tree-nodes.ts`, `heads.ts`; update isolated migration fixture and benchmark migration list.

**Interfaces:** Existing public hex IDs and object/tree/head methods remain stable. `VersionObjects.put` increments each unique child's count before inserting a new parent; dedup does not double-count. Object reads verify reference ordering/limits and payload integrity. The DB has a partial index for `ref_count=0` and no reference edge table.

- [x] Write failing tests for 32-byte disk IDs, compact adjacency, unchanged dedup counts, atomic count rollback, SQL limits, compact tree payload and guarded populated-prototype migration.
- [x] Observe RED with the core suites.
- [x] Implement additive 0053 migration: refuse populated prototype tables before changing any data; replace empty draft tables transactionally; keep production v2 untouched.
- [x] Implement binary boundary codecs and compact references; keep public hash semantics and bounded get behavior.
- [x] Encode v2 tree nodes using indexes into the sorted reference array, while validating v1 node fixtures for compatibility.
- [x] Verify all prior core tests plus new representation/integrity tests and typecheck; commit.

## Task 2 — Durable root pins and bounded metadata

**Files:** Add `version-store/pins.ts`, `resources.ts`; compact schema triggers track head/pin root references and metadata reservations. Add pin/quota tests.

**Interfaces:** `VersionPins.hold({id,objectId,kind,owner})`, `release(id,owner)`, `moveWriter({id,owner,expectedObjectId,objectId})`, `page(owner,{after?,limit?})`. Pin IDs are stable/idempotent and immutable except explicitly moved writer pins. `VersionResources.metadata()` and `setMetadataLimit(bytes)` expose a DB-global finite budget.

- [x] Write RED tests for head transfer counts, checkpoint/fork/reader protection, owner mismatch, idempotent hold/release, atomic writer-pin transfer and reopen persistence.
- [x] Add tests that metadata-limit failure rolls back head/ownership/operation/pin writes and object counts; INSERT OR IGNORE must not double-charge.
- [x] Implement after-insert/delete/update triggers and APIs. Ownership rows use RESTRICT so GC must delete them in bounded pages, not unbounded FK cascades.
- [x] Run real disk-backed two-connection tests and core regressions; commit.

## Task 3 — Bounded orphan collector

**Files:** Add `version-store/gc.ts`; extend objects internal reclaim primitive; add `checkpoint-version-gc.test.ts`.

**Interfaces:** `VersionCollector.collect({maxObjects?,maxEdges?,maxBytes?,maxOwnershipRows?,maxMs?})` returns removed counts, reclaimed logical bytes, released proof rows and whether work remains. It processes the indexed zero-reference set, verifies each bounded object, pages weak ownership proofs, then releases child counts and removes the object in one short transaction.

- [x] RED: pinned descendants survive; released roots eventually reclaim a shared DAG exactly once; each budget is honored; proof fanout is paged; failed batch rolls back; interrupted/reopened collection resumes.
- [x] Implement without loading all objects/roots/hashes and without time-based unsafe pin expiration.
- [x] Verify with a hand-checked live reference-count oracle and mixed publication/pin/GC sequences.
- [x] Run core tests and existing checkpoint regressions; commit.

## Task 4 — Repeat storage probes and soak

- [ ] Extend benchmark to retain a fixed number of checkpoint pins, collect unpinned intermediate states in bounded batches and report live/allocated/freelist/WAL bytes separately.
- [ ] Run comparable 10k/100k/1M workloads under 128MiB V8 old-space and archive raw samples. Compare compact no-GC against prior baseline before attributing gains to GC.
- [ ] Run a >=10k-operation small-data mixed-write/switch/pin/GC soak. Verify exact content, steady object counts after maintenance, finite metadata behavior and no directory/file leaks.
- [ ] Document what passed and what remains; storage tuning alone does not meet end-to-end runtime/UI/file/migration acceptance.

## Execution evidence

- Compact representation RED observed (v1 payload vs required v2), then pin modules RED, pin admission/identity guard RED and collector module RED; 60 core/CLI tests now PASS. API typecheck PASS.
- Installed libSQL 0.5.29 treats a sole Buffer argument as named binds and may abort natively; all single binary predicates now use named parameter maps. Its `.all()` returns ArrayBuffer BLOBs rather than the Buffer returned by `.get()`; the collector selects bounded hex identities instead of rebinding that raw value. Both were reproduced only in isolated processes and corrected before benchmarking.
- Metadata admission has a default 64MiB hard logical reservation ceiling; resource snapshots observe DB/WAL/SHM and freelist but do not yet enforce a physical history quota. No runtime session uses this core.
