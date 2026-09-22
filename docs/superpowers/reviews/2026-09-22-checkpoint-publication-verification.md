# Bounded publication and native delta burst verification

Verification label: 2026-09-22. Earlier artifacts keep their original device-local date labels. The overall user goal remains ACTIVE and INCOMPLETE.

## Changes that affect actual code paths

1. `RuntimeVersionRepository.putBatch` accepts <=256 records / <=1MiB input, counts bytes/nodes/depth before serialization, groups index changes and publishes one version. Superseded same-ID values do not create abandoned payload objects; their final order matches sequential replacement.
2. AgentRuntimeStore `appendEvents` and AgentEventService `appendBatch` now provide synchronous durable bursts for v3 and legacy sessions. Mixed sessions, oversized input and late SQL failures cannot partially commit. Active-work attribution keeps the existing `payload.workId` contract.
3. Checkpoint capture identity is indexed by a persistent lookup tree. Retry after intervening writes returns the original checkpoint without new object allocation. Rollback restores the prior identity tree together with the ordered checkpoint prefix, so capture cannot revive a popped branch. The repository's checkpoint code was split into `checkpoint-index.ts`.
4. Normal Native execution now coalesces adjacent display deltas BEFORE calling the durable event append path. This is not restricted to the experimental v3 cohort and therefore reduces event/undo amplification for existing v2 Native code too (after deployment; the installed app was not modified).

## Native burst policy and safety

- Flush at 20ms, 8KiB or 64 upstream delta events; type/control/retry/usage boundaries flush immediately.
- At most one upstream next() in flight. Incoming delta limit 64KiB. Per-process aggregate incoming/accumulator reservation limit 8MiB; excess raises an explicit error rather than silently dropping text.
- The source factory receives a per-step combined AbortSignal. Consumer return/force-injection aborts prefetched work before closing its generator; timers and reservations are released.
- Each emitted burst is persisted by the existing loop BEFORE being yielded to external observers. The helper itself does not acknowledge durability.
- Exact text, Unicode boundaries and upstream control object identity are preserved. Already received buffered text is yielded before a non-abort upstream error.
- Reservations cover this helper only, not the full provider result, control payloads, SQLite, IPC, renderer or every child process. Full OOM prevention and process-wide admission remain unfinished.

## Actual Native loop evidence

The provider fixture delivers 1,000 single-character deltas through the real AgentLoopRuntime, real event store and real undo triggers:

| Measurement | Before wrapping the actual loop | Current |
| --- | ---: | ---: |
| Provider deltas | 1,000 | 1,000 |
| Persisted message-delta events | 1,000 (observed RED) | 16 |
| Corresponding event undo rows | not separately measured in RED | 16 |
| Final answer | 1,000 characters | Same exact 1,000 characters |

This is a bounded immediate-burst fixture, not a claim that every provider stream will shrink by 98.4%. Slow streams still flush on the deadline; alternating event types cannot be merged across semantic boundaries. Native provider protocol/reasoning parts are unchanged.

Raw current counts: `2026-09-22-checkpoint-native-burst.json`.

## Actual 10k-event versioned route probe

The existing real-store/real-Hono probe now sends batches of 32 instead of 32 sequential publications inside each transaction. Explicit GC remains part of the test harness, not a production maintenance scheduler.

Current observed sample on Apple M4 / Node v22.23.2:

- 10,000 events constructed plus explicit GC: **6.538s**.
- Rollback route: **5.975ms**, **15 immutable-object reads**, correct restored transcript, no legacy undo journal for the v3 cohort.
- Current immutable objects: 10,489; charged logical bytes: 7,154,404.
- End-of-worker RSS snapshot: 310,116,352 bytes (~295.8MiB); heapUsed: 166,506,744 bytes (~158.8MiB).

The previous single-publication fixture took about 71 seconds; this is roughly an order-of-magnitude throughput improvement on this fixture. It is NOT a formal cold/warm percentile benchmark. The memory snapshot is higher than the earlier 236.8MiB snapshot, and does not demonstrate lower peak memory or meet an absolute 256MiB RSS cap. A separate API/process baseline and production-like allocation profiling are still required.

Raw data: `2026-09-22-checkpoint-batch-scale.json`. Reproduce with isolated DATA_ROOT and `SYNAX_SCALE_REPORT` using `checkpoint-runtime-scale.test.ts`; the destination report file must not exist.

## Verification

- Final combined isolated run: **28 test files / 230 tests PASS**, 28.70s.
- Includes all new batch/capture/stream tests, actual 10k route test, core object/tree/pin/GC and DB safety, legacy file/conflict/recovery/routes, real loop-runtime, provider protocol stream and runtime-journal tests.
- API `tsc --noEmit` PASS; benchmark/soak script typechecks PASS.
- One initial combined stream test invocation used LOG_LEVEL=error and failed an EXISTING assertion that intentionally checks info logs. Rerunning with LOG_LEVEL=info passed; no log assertion was removed or weakened.
- All experimental work uses fresh temporary DATA_ROOT fixtures. No user database reset, process kill or installed-app replacement.

## Completion audit: still incomplete

- V3 full execution is still guarded off. Only explicit fresh inactive transcript sessions use versioned rollback; ordinary sessions still use legacy history.
- Next critical implementation step is the actual execution/control entity bridge: runs, steps, parts, tools, interactions, permissions, contexts/work/assets/children, and all direct-SQL consumers. Then remove the cohort execution guard, wire edit/resend/fork and verify actual native execution on v3.
- The synchronous batch API is NOT an asynchronous production queue. Runtime writer ownership, safe flush barriers, global admission across processes and foreground/GC scheduling remain required.
- Frontend pagination/projections, file manifests/compensation, v2 history migration, downgrade protection and physical DB/WAL/temp/blob budgets are still unfinished.
- Legacy arbitrary-long rollback is still linear even though Native delta amplification is reduced. Do not equate this mitigation with the final root-switch solution.
- Remaining checkpoints include end-to-end million-event/cold/concurrent/UI/file tests, real OOM/disk-full/crash recovery and physical storage steady-state acceptance.
