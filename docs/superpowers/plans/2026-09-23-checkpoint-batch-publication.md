# Bounded runtime batch publication plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans, keep the existing isolated worktree and test-first workflow.

**Goal:** Remove measured per-event root/index write amplification in actual runtime storage; the full execution/files/UI/migration objective remains open.

**Architecture:** Preflight bounded JSON input (rows, bytes, depth, nodes), collapse superseded same-ID values inside a batch while preserving consumed ordering slots, update each affected index in bounded chunks, then publish exactly one version. Expose synchronous batch append through AgentRuntimeStore/AgentEventService without introducing unbounded asynchronous queues or falsely acknowledging non-durable writes.

**Tech Stack:** Existing TypeScript, libSQL, Vitest; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-23-checkpoint-performance-design.md`

## Constraints

- At most 256 rows / 1MiB serialized input per batch; finite traversal nodes/depth before serialization or SQL.
- Empty batch is a no-op. A failure rolls back objects, indexes, head, epoch and all mutable counterparts.
- One session per batch; same-ID last write wins, preserving last-write position and exact incremental counts.
- Event-type indexes remove replaced entries from the old type and add to the new type.
- No background buffering, per-token acknowledgements before durability, default v3 enablement or loss of legacy behavior.
- Files, run/control consumers, workers, UI, migration, physical-disk admission and full resource acceptance are still required.

## Task 1 — Bounded admission and repository batch writer

Create `version-runtime/batch-input.ts` and `batch-write.ts`; refactor repository `put` to share the bounded path-copy algorithm.

- [x] RED tests: one revision per batch, empty no-op, identical observable order/content vs sequential writes, replacement across event types, stale checkpoints unchanged, per-batch byte/row/node limits, accessor/cycle rejection before writing, and full rollback after late failure.
- [x] Implement a byte-counting JSON visitor that never stringifies an over-budget object and does not execute getters/toJSON callbacks.
- [x] Build only final retained record versions in a batch; update ID/order/type roots in chunks <=256 tree changes and publish the aggregate state once.
- [x] Verify lower immutable object allocation than sequential writes with actual DB statistics, not mocked performance.

## Task 2 — Real store/event-service batch API

- [x] RED tests through AgentRuntimeStore and AgentEventService for versioned and normal v2 sessions, mixed-session rejection and atomic legacy failure.
- [x] Add synchronous appendEvents/appendBatch methods, retaining metadata attribution and caller event order.
- [x] Use the real batch path in the 10k route-scale fixture; retain an independent correctness test for the old single-row path.
- [x] Avoid marking streaming execution integrated: model loop still needs a bounded durable burst protocol before changing its per-event yield semantics.

## Task 3 — Verification

- [x] Run isolated regression suites and API/script typechecks.
- [x] Measure actual 10k-event ingestion + explicit maintenance, rollback route, SQL/object work and memory snapshots; compare with the previous 71-second fixture, recording workload differences.
- [x] Record remaining throughput, resource and integration gaps; keep the original goal active.

Verification so far: isolated 24-file / 152-test run PASS; API typecheck PASS. The actual 10k route fixture uses appendEvents in 32-row bursts (construction plus explicit GC ~6.8s, rollback ~6ms). Broader runtime/stream integration and complete goal acceptance remain open.
