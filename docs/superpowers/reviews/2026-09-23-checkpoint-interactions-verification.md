# Versioned Synax human interactions — verification

Date label: 2026-09-23. Full goal status remains ACTIVE / INCOMPLETE.

## What changed

- Clarification and plan approval requests, replies, defer, consume and cancel now publish immutable interaction history atomically with their mutable control projection for explicit Native v3 sessions.
- Migration 0061 adds interaction version_epoch and current/unconsumed indexes. The rollout guard is relaxed only for explicit Native mode; normal legacy sessions keep their behavior.
- Historical interaction lists resolve current branch membership. Pending/ready input uses current epoch and bounded indexed lookups, not a full scan of historical forms.
- Reply/defer checks epoch and immutable branch membership inside the transaction before applying plan approval or trusted-human-acceptance side effects.
- Old pending snapshots normalize to cancelled. A retained old approval and a popped future approval both reject late answers after history replacement, even if mutable session/control fields are manually reset in the test.
- Cancellation reads at most 256 identities and fails explicitly if more unresolved work needs recovery, rather than materializing arbitrary historical request JSON. Reads of bodies are one at a time; lifecycle-wide control retention remains unfinished.

## Actual default Synax workflow

The existing real AgentLoopRuntime form/plan test now runs both legacy and v3 cases:

1. The `synax` profile in plan mode invokes human.ask.
2. Execution waits for an input form.
3. The user submits a validated answer; the original tool call is resumed and exactly one tool-result part is recorded.
4. plan.propose offers the one-time execute/cancel choice.
5. Cancel and resume ends with the saved plan and no pending input.

Additional Native tests cover explicit plan execute (approved plan, chat mode), defer/save, duplicate replies, one-time consumption, quota rollback, and reopening the database after a durable answer.

## Integration defect caught by the real loop

The direct service fixture passed, but the actual Native tool invocation failed because interaction construction spread the entire ToolExecutionInput. That object included AbortSignal and other runtime-only fields. The version codec correctly refused its non-JSON prototype.

The fix whitelists durable interaction identity fields instead of accepting arbitrary prototypes or dropping the admission guard. A regression test verifies that abortSignal/args are neither returned as interaction fields nor stored in the immutable record.

## Verification

- **34 test files / 289 tests PASS**, 34.55 seconds, in a generated temporary DATA_ROOT.
- API `tsc --noEmit` PASS and `git diff --check` PASS.
- Includes Native and legacy interaction tests, real Synax loop/provider fixtures, run coordinator, restart recovery, Native edit/rollback/lease tests, core object/tree/GC tests, existing file conflict/compensation/history-route tests and benchmark/soak CLI tests.
- SQLite EXPLAIN confirms ready-input lookup uses `idx_interactions_unconsumed_epoch`; consumed historical forms are not its search set.
- Quota failure rolls back both mutable answer status and version root. Database reopen preserves the durable response and does not consume it twice.

No new whole-application latency percentile, peak RSS, physical disk bound or release-readiness claim is made by these tests. Production v3 default enablement and existing-session migration were not performed. The installed app and real user database were untouched.

## Still required for the original goal

1. Versioned file restore/compensation: includeFiles=true remains guarded. File planning still has legacy whole-history reads and must become scoped/paged with a durable bounded plan before enabling it.
2. Attachments/assets, child sessions and fork ownership/lifetime semantics.
3. Remaining direct SQL readers (search/snippets, recent workspace reads, usage/history distinctions, exports, recovery/sweeper pagination) and UI cursor/projection support. This report does not prove there are no stale-branch inputs through those unported channels.
4. Resumable bounded v2 checkpoint/history migration and downgrade protection. Existing long sessions still use the legacy history implementation.
5. Physical DB/WAL/temp/blob admission, control/audit/stream retention, production GC scheduling, worker isolation and globally bounded queues/cache/process memory.
6. Full cold/concurrent/million-event Native/API/UI/file runs, crash/ENOSPC fault injection, and memory/storage steady-state acceptance. Core benchmarks and the current workflow tests are insufficient to mark the complete goal achieved.
