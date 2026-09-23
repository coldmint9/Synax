# Bounded file planning and v3 restore/compensation verification

Date: 2026-09-23. Overall goal remains ACTIVE / INCOMPLETE.

## Implemented

- File-inclusive preview, rollback and edit/resend now work for explicitly initialized Native v3 sessions. Transcript-only internal mode still rejects unsupported file operations; no default enablement or existing-data migration was added.
- File planning uses owner/cursor indexed keyset identity pages (64 rows), a fixed mutation high-water bound, and one SQL-size-guarded JSON payload at a time. Empty owned plans do not inspect foreign payloads. When foreign path evidence is sufficient, oversized unrelated before-image metadata is not loaded.
- Plan/diagnostic accumulation is budgeted at 1MiB; duplicate warnings/conflicts/preservation records are deduplicated during accumulation. Git promise caching has entry and key-byte limits.
- Workspace fence acquisition selects active session identities rather than materializing all sessions. Open-writer roots are paged and size-guarded. Existing overlap/process safety checks remain.
- A shared bounded filesystem journal records preparation and applied progress. Files restore first; version switching, input update/new-run admission, mutation retirement, final result and journal commit then happen in one database transaction.
- Only that transaction releases the operation's own fences before ordinary admission checks; failure rolls the release/commit state back before compensation. No new execution starts before file+history publication commits.
- Canonical request hashing makes successful retries return their stored result before touching files. A manual edit made after successful rollback is not overwritten by a retry.
- Known before/after versions are used for compensation. If compensation sees a newer external edit, it preserves that edit and keeps recovery_required/workspace fencing. The existing recover endpoint can complete compensation after the conflict is resolved.
- V3 checkpoint summary now reports recoveryRequired from the durable journal, so existing UI recovery controls are not hidden during a file recovery failure.

## Tests with real temporary files/databases

New v3 cases verify:
1. Restoring an existing file and deleting a session-created file, together with the immutable transcript switch.
2. Human-content conflict rejects without changing the head or unrelated files.
3. Injected second-file failure compensates the first file and keeps the original head.
4. Metadata admission failure after filesystem restoration compensates files and rolls back history/admission.
5. A new human edit during failure causes a retained recovery fence; explicit recovery later restores the pre-operation future version without overwriting the human edit automatically.
6. Committed Git changes remain untouched; a foreign session's same-content write is still an ownership conflict.
7. Workspace lock discovery no longer calls the old unbounded listSessions method.
8. Actual Native initial edit/resend with file inclusion restores the file, admits one replacement run and retains quota/idempotency/context protections.

The owner/JSON budget tests also exercise 500 mutation identities, duplicate warning accumulation, oversized owned JSON, and unrelated foreign metadata. Existing legacy commit/expiry/unknown-writer/compensation tests remain in the run.

## Verification result

**36 test files / 300 tests PASS**, 36.56s, under an isolated temporary DATA_ROOT. API `tsc --noEmit` and `git diff --check` PASS. The regression set includes prior Native/interaction/coordinator/core/DB safety/history/file recovery/route suites and benchmark/soak CLI tests.

The running installed application and real user database were not changed. These are correctness and bounded-materialization results, not a new whole-application seconds-level latency or peak-RSS acceptance benchmark.

## Remaining performance/resource work (must not be presented as achieved)

- The compatibility plan still visits relevant mutation history. Foreign ownership checks can traverse many foreign mutation identities. It is not yet the persistent-file-manifest diff design where repeated writes to one file do not add planning work.
- Plans exceeding the in-memory budget are explicitly rejected. Durable paged planning/apply/recovery jobs and their UI/API progress handling are not implemented; this is not arbitrary-scale file restore support.
- Retirement of a popped file-mutation suffix and expiry cleanup still use bulk SQL. Other file GC/write-lease paths retain legacy whole-history queries and need bounded maintenance work.
- Legacy active-child enumeration and some workspace-policy discovery can still be large; worker isolation and foreground scheduling are not complete.
- Real physical DB/WAL/temp/blob limits, filesystem space reservation, control/audit/stream retention and system-wide memory/queue/cache limits remain incomplete. Logical quotas alone do not prove bounded physical resources.
- Assets, child sessions/fork, unported direct SQL consumers, frontend cursor handling, resumable v2 migration and downgrade protection remain part of the original goal.
- Required large/cold/concurrent/native/API/UI/file, process-crash/power-loss/disk-full and steady-state tests remain open. Existing tests cover the listed injected failures; they do not establish arbitrary external-filesystem atomicity or all power-loss guarantees.
