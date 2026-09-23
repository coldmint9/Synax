# Bounded file planning and v3 compensation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans with test-first execution.

**Goal:** Enable safe file-inclusive v3 rollback/edit using bounded planning and durable compensation, while keeping the full extreme-performance/resource/migration objective open.

**Architecture:** Replace whole-history `.all()` with owner-scoped keyset identity pages and one guarded JSON payload at a time; bound plan/diagnostic bytes and Git cache. Preserve ownership/Git/expiry semantics. Reuse the durable filesystem operation journal and workspace fences, then atomically publish the versioned history result only after file writes succeed. Failures compensate known versions; conflicts preserve external edits and retain recovery fences.

**Important scope boundary:** This is an integration step, not the final persistent-file-manifest performance design. Planning still visits relevant mutation records; very large plans need durable paged plan storage/worker APIs. Explicit resource rejection is preferable to OOM but is NOT a claim of full-scale acceptance.

## Tasks

- [x] RED tests: owner filtering, no foreign payload loading for empty plans, SQL-guarded oversized payload rejection, preservation of cross-session/same-content ownership conflicts and bounded accumulation.
- [x] Add owner/cursor index; keyset mutation reader with fixed high-water cursor and cooperative yields; prevent an unbounded Git promise cache and deduplicate diagnostics on insertion.
- [x] Preserve existing legacy file plan tests, including commits, human changes, expiry and unknown provenance.
- [x] RED real v3 file tests: restore + retry, manual conflict, same-content foreign ownership, partial-write compensation, post-file DB/quota failure, retained recovery conflict and explicit recover.
- [x] Extract guarded journal primitives used by both legacy and v3; keep files+version-result compensation semantics and validate fresh Git/file versions before each write.
- [x] Use canonical request hashing for retries. File writes do not start on a stale revision; no edit run is admitted until file restoration and root publication commit together.
- [x] Do not bypass workspace fences during admission; transition journal state and release its own locks in the same final transaction before normal admission checks, rolling those changes back on failure.
- [x] Bound recovery payload materialization. Test all changes against legacy recovery, Native edit, interaction, DB safety and core tests. No installed app/user DB writes.

## Evidence and limits

- Final isolated regression: 36 files / 300 tests PASS (36.56s); API typecheck PASS. Real v3 file rollback/edit, retry, human/foreign/Git preservation, partial-write compensation, post-file metadata failure and explicit conflict recovery are covered.
- Planning now holds at most 64 sequence identities plus one guarded payload at a time; accumulated plan/diagnostics and recovery journals are limited to 1MiB, with a bounded Git cache. Competing-owner discovery no longer loads every session's metadata.
- This does not implement immutable file-manifest diffs or durable arbitrarily large paged restore jobs. Relevant mutation traversal, bulk file-mutation retirement, expiry cleanup and some other maintenance remain history-sized. Oversized plans fail explicitly before file application; the original full performance/resource objective stays open.
