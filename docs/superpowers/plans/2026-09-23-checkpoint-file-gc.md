# Version-aware bounded file GC plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans, test first, isolated DATA_ROOT only.

**Goal:** Prevent file GC from deleting v3 undo evidence, and eliminate its whole-history JSON/Set and directory-array memory growth. This is a prerequisite to safe default rollout, not full goal completion.

**Architecture:** Maintain a conservative file-retention cursor on each versioned head, alongside checkpoint-root publication. File GC combines v2/v3 floors before retiring old mutation evidence. Reference marking reads bounded identities and one size-guarded source at a time into an on-disk SQLite hash set with a finite page budget; sweeping begins only after marking completes. Stream directory entries instead of readdir arrays. Keep existing exclusive snapshot lease safety and abort without deleting blobs if marking cannot complete safely.

## Constraints and known limits

- Never infer that absent v2 checkpoints means there are no live v3 file checkpoints.
- Existing draft v3 heads with checkpoints get conservative floor=0; no destructive history inference during migration.
- Source payload <=1MiB per read; identity pages <=64; scratch DB cache 2MiB and main-file cap 64MiB. A too-large/corrupt source or scratch failure aborts collection before blob deletion.
- Scratch state is never reused as a completed mark after crash. Its known scratch filename is bounded and cleaned under the GC lease.
- Checkpoint retention floor is conservative on prefix trims and becomes NULL only for an empty checkpoint set.
- No unbounded JavaScript hash Set, full JSON result array or full directory listing.
- This phase still has an exclusive GC lease and history-sized total scan, and is NOT a proof of seconds-level latency or complete physical/WAL/temp admission. Normalized ref barriers/resumable worker maintenance remain later work.

## Tasks

1. [x] RED real v3 test: GC with zero legacy checkpoints must preserve mutation evidence and before-image blobs and allow actual rollback afterward.
2. [x] Add 0063 head floor column/index and atomic capture/truncate updates; verify empty-prefix release and conservative compatibility.
3. [x] RED bounded collection tests: oversized reference source refuses deletion, multiple reference sources survive, repeated scans reuse no stale marks, and directory walking does not depend on readdir arrays.
4. [x] Implement capped disk-backed marks, guarded paged reference scan and streamed sweep; release leases and scratch resources on every failure path.
5. [x] Page mutation/result cleanup, expiry owner discovery and lease/writer identity discovery without materializing historical JSON collections.
6. [x] Run existing file expiry/commit/recovery and all targeted Native/core/GC regressions; document unproven latency/storage limits and keep the full goal active.

## Execution evidence

- The v3-only retention test first lost its before-image under the legacy collector; the floor projection now preserves evidence and the real rollback succeeds after collection.
- Oversized/malformed reference JSON aborts before blob sweep; stale marks are not reused. Membership queries require a sealed complete mark. Directory iteration and owner identity scans are bounded.
- Final isolated run: 38 files / 307 tests PASS (96.22s). API typecheck PASS. These timings include test/import work on a shared machine, not GC latency acceptance.
- Marking still scans history under an exclusive snapshot lease. Source rows over 1MiB and scratch exhaustion intentionally abort rather than delete unproven garbage. Per-owner expiry transactions, resume scheduling, cross-platform fault tests and complete physical resource admission remain unfinished.
