# Atomic versioned edit-and-resend plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans with failing real-runtime tests before implementation.

**Goal:** Implement the user's edit/rollback flow on explicit v3 Native sessions, not just reply rollback. Full file restoration, migration, UI and resource gates remain in scope and unfinished.

**Architecture:** One transaction restores the pre-input version, trims checkpoint identity/order roots, hides the omitted accepted run, resets obsolete queued control metadata, updates initial prompt when applicable, admits exactly one new run and stores the final idempotent operation result. A bounded result table is charged to the existing metadata quota. No native execution starts before commit; existing route/coordinator launch the admitted run after success.

- [x] RED tests: edit first message, reuse same request after admission/execution, conflicting message/hash, new run only once, original input boundary removed, obsolete accepted run hidden, and recovery-safe result persistence.
- [x] Add bounded v3 history-result migration and read/save helper, with budget rollback tests.
- [x] Add bounded immutable record removal and checkpoint truncation excluding an input boundary.
- [x] Extend repository restore kind/hash semantics; keep the separate operation result authoritative after subsequent admission writes advance revision.
- [x] Integrate Native edit into existing applyHistory; retain file-inclusive and non-Native rollout guards until those flows are ported.
- [x] Execute the admitted edited run through real Native loop and verify final transcript/context excludes the old prompt and answer.
- [x] Run legacy history/file/conflict/recovery plus Native/coordinator/core regression tests; document remaining requirements honestly.

## Execution evidence

- Final isolated run: 31 files / 261 tests PASS (31.71s), including actual Native turns, admitted read-tool steps/parts, coordinator leases/journal, root rollback and continued execution, and idempotent edit-and-resend with quota rollback. API and probe typechecks PASS.
- Current mode is still explicit, fresh-session-only; default v2, file-inclusive history, assets/subagents/interactions, migration, UI and full physical resource admission remain unfinished. Control/audit row lifetime retention is not yet implemented.
