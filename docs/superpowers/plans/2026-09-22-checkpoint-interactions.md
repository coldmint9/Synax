# Version-aware human interaction plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans with failing tests first.

**Goal:** Port clarification/plan-approval request, reply, consume, defer and cancellation into the actual versioned Native workflow. Keep the full file/migration/UI/resource objective open.

**Architecture:** Immutable interaction records define branch visibility; mutable interaction rows are live input-control projections tagged with the current session epoch. Reads for pending/ready are indexed and current-epoch only; reply/defer validates branch membership and epoch inside the same transaction before applying any plan or acceptance side effect. Every control mutation publishes historical state atomically. Old pending snapshots normalize to cancelled and never reactivate input after rollback.

**Tech Stack:** Existing TypeScript, SQLite/libSQL and Vitest; no new dependencies.

- [x] Add RED tests for Native clarification lifecycle, idempotent reply/one-time consume, plan defer, and late answers to rolled-back or retained old-generation approvals.
- [x] Add 0061 interaction epoch column/index and relax only explicit Native interaction SQL guards.
- [x] Extend version entity mapping/normalization and implement bounded interaction-control helpers; do not list/parse all historical interaction JSON to find pending work.
- [x] Integrate request/reply/defer/consume/cancel without weakening legacy behavior, revision checks or current-run checks.
- [x] Exercise the real default Synax human.ask → plan.propose → cancel/resume loop on v3; verify retained/discarded interaction visibility and stale approvals.
- [x] Run Native/legacy interaction, plan, coordinator, history/file/core regressions and typechecks; record unfinished file/assets/children/migration/UI/physical-resource gates.

## Evidence

- Initial direct Native request failed at the transcript SQL guard. After entity/control integration, direct lifecycle tests passed; the real default Synax loop then exposed an AbortSignal leaking through an input-object spread. Durable field whitelisting fixed that without relaxing JSON admission.
- Final isolated run: 34 files / 289 tests PASS (34.55s). API typecheck PASS. Current-epoch ready lookup is verified by SQLite EXPLAIN to use the partial unconsumed index.
- Native and legacy clarification/plan workflows, late/foreign/stale answers, quota rollback and database reopen are covered. Physical control-row retention and the original file/assets/children/migration/UI/resource acceptance gates remain incomplete.
