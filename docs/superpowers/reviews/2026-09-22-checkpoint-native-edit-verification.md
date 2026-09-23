# Native versioned execution and edit/resend verification

Verification label: 2026-09-22. Goal status: ACTIVE / INCOMPLETE. This is a phase report, not release acceptance.

## Real workflows now exercised

- Explicit Native v3 initialization of a fresh inactive session, with an explicitly seeded initial context. No existing session is automatically converted and no public/default enablement was added.
- Two real AgentLoopRuntime turns, checkpoint rollback and a third turn on the retained branch; the discarded transcript is absent.
- Native admission followed by a real two-step file-read tool turn: scoped runs/steps/parts/tools and permission decisions persist and return correctly.
- A real RunCoordinator driving AgentLoopRuntime under execution leases, recording completion through runtimeJournal and closing the live lease.
- Edit of the first Native input: restore the pre-input root, trim the input checkpoint and lookup boundary, omit the original accepted run, update initial prompt, admit one replacement run and persist the final result in one transaction.
- The edited run produces only the replacement question/answer. The next model request is checked not to contain the original question or answer. Repeating the edit request before or after execution returns the same committed result and does not admit a second run; changed input under the same request ID is rejected.

## Historical state versus execution authority

Historical runs, steps, parts, tools, permissions, artifacts, contexts, thinking/compaction records and work state use immutable records. The existing mutable SQL rows remain execution/recovery/audit projections and ID-to-session locators; they are not the branch membership authority.

- Historical records strip executionLease/recovery fields.
- A per-run numeric version_epoch is stamped atomically with run insertion/replacement. Stamping afterward was unsafe because the shared write fence would observe a transient missing epoch during an active execution; the coordinator test caught this.
- Shared execution-context validation checks BOTH the existing lease string and session history epoch. Reopening an obsolete run's old lease does not let it mutate the new branch.
- A read first checks immutable branch membership. Popped runs cannot be read by ID just because their audit row still exists.
- Current-epoch recovery status can be overlaid from the live control row, while old running/pending historical states normalize to interrupted/failed/denied, without restoring authorization.
- Run/step immutable secondary indexes avoid scanning unrelated session entities. Ordinary entity updates preserve their insertion order rather than moving them to the end of the history.

The control/audit projection currently retains rows/payloads and still needs explicit lifetime/physical-space admission and cleanup. This phase does NOT establish a bounded total disk footprint for arbitrary Native execution lifetimes.

## Stream and checkpoint safety fixes

- Stream journal rows carry a history epoch and current-epoch reads/cursors use the corresponding index. A rollback does not replay streaming content from the discarded generation.
- A stale stream writer finalizer abandons its work after epoch replacement instead of looking up a popped run and throwing or creating a duplicate partial message.
- Completed-reply capture reads bounded message metadata through a step scope. A 2MiB assistant reply can be checkpointed without materializing that content into the metadata query.
- A durable bounded history-result table preserves exact post-admission idempotency results even after the head revision advances. Its JSON/row bytes count toward the existing metadata quota.
- Quota failure during edited-run admission/result persistence rolls back the head, checkpoint roots, control changes and newly accepted run. The test verifies both head identity and visible run identities are unchanged.
- Obsolete input queues/force-injection/resume metadata are cleared on history replacement; current permissions remain authoritative.

## Migrations added

- 0057: explicit transcript/native runtime mode (default remains transcript for internal versioned heads).
- 0058: version_epoch on ported mutable control tables; relax guards only for the explicit Native mode.
- 0059: current-epoch stream journal indexing.
- 0060: bounded, metadata-charged immutable history-operation results.

Unported interactions/assets/subagent paths retain their rollout guards. File-inclusive v3 history requests remain explicitly rejected rather than silently ignoring files.

## Verification evidence

Final run against a generated temporary DATA_ROOT: **31 test files / 261 tests PASS**, 31.71 seconds. API `tsc --noEmit` and standalone probe typechecks PASS. `git diff --check` PASS.

Coverage includes new scoped-index/entity tests, actual Native loop/admission/coordinator flows, edit/context/idempotency/quota tests, stale-epoch writes and stream replay, large-reply capture, core storage/GC and all previously targeted legacy file/conflict/recovery/history routes.

An intermediate broad run cascaded after one test teardown forgot the new history-result foreign-key row. Test-owned teardown was fixed in `__tests__/version-session-fixture.ts`; no production foreign-key/rollout protection was disabled. The later complete run passed.

No new production latency percentile, peak RSS or physical-storage acceptance claim is made here. Older core/transcript probes do not automatically cover these new execution/control paths. No installed application or real user database was changed.

## Remaining objective, not optional polish

1. Port interaction/clarification/plan approval, assets, subagents and fork semantics; verify the default Synax/goal workflow, not only executor text/read-tool fixtures. The explicit Native mode is not yet universal feature parity.
2. Finish direct SQL consumers: search/snippets, recent workspace reads, usage/history distinctions, exports, recovery/sweeper pagination and full UI cursor/projection support. Check that discarded branch data cannot re-enter model context through those other channels.
3. File manifest comparison, Git/external-write preservation, durable multi-file compensation and recovery; includeFiles=true is still guarded for v3.
4. Resumable bounded v2 checkpoint/history migration and downgrade compatibility. Existing sessions still follow the legacy rollback implementation.
5. Physical DB/WAL/temp/blob admission and bounded control/audit/stream retention, foreground worker scheduling, global queues/caches and process memory caps. Current metadata/object limits do not cover every physical resource.
6. Production-like cold/concurrent/million-event Native/API/UI/file tests, crash/ENOSPC/restart/late-writer fault injection, and steady-state memory/storage measurements.

The original goal cannot be marked complete until these end-state requirements are implemented and verified.
