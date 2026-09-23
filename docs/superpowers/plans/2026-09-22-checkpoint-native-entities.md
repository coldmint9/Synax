# Versioned Native execution entities plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans; test-first, local worktree only.

**Goal:** Move from transcript-only test sessions to actual Native execution on an explicitly selected versioned cohort, while retaining the complete files/UI/migration/resource objective.

**Architecture:** Immutable historical records become the source for branch-scoped runs/steps/parts/tools and context state. Existing mutable rows remain a bounded-to-be-managed control/audit projection for execution leases and recovery (not the history read source); a per-run numeric version epoch fences them after rollback. Entity updates retain their original order; immutable run/step secondary indexes avoid filtering whole-session lists. An explicit head runtime mode distinguishes transcript testing from supported Native execution; ordinary sessions remain unchanged.

**Tech Stack:** Existing TypeScript/libSQL/Vitest, no packages.

## Constraints

- No user database, installed app or production branch changes; no `.DS_Store`.
- Historical execution leases are stripped; current leases may be read only from the mutable run control row of the current epoch.
- Old-epoch writes must fail at the shared execution-context boundary even if a run's previous lease string matches.
- Active execution/process checks remain mandatory for rollback; no resurrection of queued/running actions from a checkpoint.
- Scope queries use immutable secondary indexes and bounded pages; ID ownership cannot switch sessions.
- Scope initially excludes unported asset/subagent/interaction flows; their SQL guards remain until implemented. This temporary restriction is not a completion claim.
- Control/audit projection retention, physical disk admission and large materialization limits are explicit remaining gates; never claim the control rows are already bounded by lifetime.

## Tasks

1. [x] RED→GREEN immutable scope indexes (runId/stepId), stable entity update order, scope cursor binding and scoped counts without whole-session scans.
2. [x] Add 0057 runtime mode and epoch columns; relax only ported native entity SQL guards. Preserve strict transcript guards and message/event immutable routing.
3. [x] Introduce `version-runtime/entities.ts`: atomic physical-control write + historical publication; sanitize lease fields; normalize historical pending/running states after epoch replacement; current-branch membership required.
4. [x] Integrate AgentRuntimeStore run/step/part/tool/permission/artifact/context/thinking/compaction methods. IDs use current small control rows for scope discovery; reads must resolve the immutable branch before exposing content.
5. [x] Add Native initializer and mode-aware admission. Seed the initial context explicitly, recheck fresh inactive state, retain default v2 behavior.
6. [x] Extend shared execution-context fencing to per-session version epoch. Verify stale lease cannot write after rollback and historical reads do not expose live leases.
7. [x] Real Native loop test: two executed turns, checkpoint rollback, subsequent third turn excluding discarded transcript; read/tool scope tests and legacy regressions.
8. [x] Report unfinished flows (interactions/work/assets/children, fork/edit/files, UI/worker/migration/storage) and next critical path before lifting remaining guards/default enablement.

## Execution evidence

- Final isolated run: 31 files / 261 tests PASS (31.71s), including actual Native turns, admitted read-tool steps/parts, coordinator leases/journal, root rollback and continued execution, and idempotent edit-and-resend with quota rollback. API and probe typechecks PASS.
- Current mode is still explicit, fresh-session-only; default v2, file-inclusive history, assets/subagents/interactions, migration, UI and full physical resource admission remain unfinished. Control/audit row lifetime retention is not yet implemented.
