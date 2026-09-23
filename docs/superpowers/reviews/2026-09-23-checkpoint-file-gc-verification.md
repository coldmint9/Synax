# Version-aware bounded file GC verification

Date: 2026-09-23. Overall goal: ACTIVE / INCOMPLETE.

## Safety defect fixed

The old file collector computed retention solely from `conversation_checkpoints`. V3 stores checkpoints in immutable trees, so a v3-only application could have zero legacy checkpoint rows. The collector then treated all closed mutations as disposable and removed live file before-images.

A real test reproduced this: capture a v3 checkpoint, write a file, collect with zero legacy checkpoints, then attempt rollback. It failed before the fix because the blob/evidence was gone; it now passes and restores the original file.

Migration 0063 adds a conservative `file_retention_floor` to versioned heads. Capture updates it atomically with checkpoint roots; prefix truncation retains the lower bound while checkpoints remain and releases it when the ordered set is empty. Existing draft v3 heads receive floor=0 rather than a destructive guessed cursor. GC combines v2 and v3 floors before retiring mutation evidence. The bound may intentionally over-retain metadata; exact compacted file manifests remain future work.

## Memory-growth changes

- Historical reference sources are traversed by bounded rowid pages (64 identities), with at most one <=1MiB JSON payload returned to JavaScript at a time.
- Oversized or malformed sources stop the cycle before any blob sweep. A failed mark does not become proof that an object is garbage; the GC lease is released on the tested failure path.
- A private disk-backed SQLite scratch set replaces the whole-history JavaScript hash Set. Its main database is limited to 64MiB and its page cache to 2MiB; hash insert batches hold at most 256 hashes and yield cooperatively. These limits are NOT a total process-RSS or total temporary-files limit.
- The mark must be explicitly sealed after all sources finish. Membership queries cannot run before that point; later additions are refused. A new cycle deletes the known old scratch state instead of reusing a partial mark from a crash.
- Directory sweeping uses opendir with bounded entry buffers, not full readdir arrays. Symlink entries/directories are skipped.
- Mutation retirement is chunked. Completed journal compaction reads one guarded row; fork manifests remain live roots. JSON kind/validity inspection is done without constructing an entire JS object graph.
- Background expiry owner discovery yields between identity pages. Snapshot-lease and orphan-writer discovery also use identity pages rather than unbounded arrays.

## Verification

**38 test files / 307 tests PASS**, 96.22s, with a generated temporary DATA_ROOT. API `tsc --noEmit` and `git diff --check` PASS.

New evidence covers v3-only file safety, floor release/conservative retention, oversized/corrupt source abort, lease cleanup, streamed directory traversal, fresh mark rebuilding, explicit sealing and paged owner discovery. Existing file expiry, commits, compensation, Native edit/interaction/coordinator, core GC, DB safety, route and probe tests remain in the run.

No installed application or real user database was altered. No new p95/p99, production peak-RSS or physical-storage acceptance result is claimed.

## Important unfinished limits

1. This collector still performs a whole reference scan under an exclusive snapshot lease. It yields to the event loop, but managed file writers can wait on that lease. Large cycles are not proven to meet seconds-level latency. A normalized ref barrier or resumable worker design is still needed.
2. A source exceeding 1MiB or the finite scratch capacity aborts safely; automatic streaming migration/repair for such histories is not implemented. This is backpressure, not arbitrary-scale acceptance.
3. Per-owner expiry remains an atomic bulk update; explicit synchronous expiry entry points and some file-writer paths still need further bounded scheduling. Long-lived PID reuse/host-identity recovery needs lifecycle work beyond the existing conservative ESRCH rule.
4. Scratch rollback-journal/filesystem overhead, Windows handle behavior and actual disk-full/power-loss cases have not received full cross-platform fault testing. The scratch main-file cap is not a whole-system disk reservation.
5. Persistent file-manifest diff performance, paged file restore jobs, assets/children/fork, remaining SQL readers, UI paging, v2 migration/downgrade protection, physical resource admission and final cold/concurrent/end-to-end acceptance remain part of the original goal.
