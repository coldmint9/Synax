# Durable checkpoint capture identity plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and the existing test-first workflow.

**Goal:** Match legacy idempotent capture without scanning retained checkpoints or retaining discarded branch snapshots through a lookup table.

**Architecture:** A second persistent lookup tree maps (kind,messageId) to a small locator (ordinal,nonce ID). Each checkpoint references the lookup root from immediately before its capture; the head pins the current lookup root. Rollback restores that prior lookup and inserts only its retained boundary locator while truncating the ordered checkpoint tree. Both roots and the head switch commit atomically. Locators contain no version refs and cannot pin discarded business history.

**Tech Stack:** Existing libSQL, immutable tree and TypeScript/Vitest. No dependencies.

**Spec:** `docs/superpowers/specs/2026-09-23-checkpoint-performance-design.md`

- [x] Add RED tests for capture retry after intervening writes, constant object/revision on retry, same anchor across distinct kinds, and retry after a branch was popped/recreated.
- [x] Add migration 0056 for checkpoint lookup root, strong-root triggers and an index; update the isolated schema manifest.
- [x] Extract checkpoint-index responsibilities from the large runtime repository into `version-runtime/checkpoint-index.ts`.
- [x] Capture stores lookup-before reference; retry verifies the locator points into the currently retained ordered root. Rollback reuses that before-tree and a bounded single-locator update; never load all anchors.
- [x] Maintain support for draft checkpoints lacking lookup-before: fail closed on a duplicate conflict and retain existing reads; do not invent historical lookup state for migrated production v2 (migration remains a separate unfinished task).
- [x] Add real store duplicate-capture test, run core/runtime/file/DB regression suites and typechecks.
- [x] Record remaining full-runtime/execution/file/UI/migration/physical-resource work; do not call the overall goal complete.

Verification so far: isolated 24-file / 152-test run PASS; API typecheck PASS. The actual 10k route fixture uses appendEvents in 32-row bursts (construction plus explicit GC ~6.8s, rollback ~6ms). Broader runtime/stream integration and complete goal acceptance remain open.
