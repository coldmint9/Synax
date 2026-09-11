# Synax Agent Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Deliver plan/goal modes, persistent form-based human input, and task-defined specialist subagents.
**Architecture:** Extend existing AgentLoopRuntime, ToolRegistry, session metadata and child sessions. Persist interaction checkpoints in SQLite; keep permission enforcement server-side and events as notifications only.
**Tech Stack:** Existing TypeScript, Zod, libsql, Hono, React, Vitest. No new dependencies.
**Spec:** docs/superpowers/specs/2026-09-10-agent-modes-design.md

## Global Constraints
- Native Synax only; preserve ACP and legacy plan_node behavior.
- Do not change unrelated workspace edits or live data. Tests use temporary DATA_ROOT.
- Approval never elevates tool permissions. No shell escape from plan or scoped-child restrictions.

### Task 1: Durable interaction checkpoint and plan policy (main)
Files: new control-contracts.ts, interaction-service.ts, control-tools.ts and 0026_agent_interactions.sql; existing contracts.ts, session-store.ts, tool-registry.ts, loop-runtime.ts, loop-resume.ts, session-runtime.ts, agent-runtime route and process/proxy lifecycle.
Interfaces: schema/types in control-contracts; interactionService.request/list/reply/pending/consume; mode policy applies before effects and on resumes.
- [x] Add failing interaction and policy tests.
- [x] Persist validated requests and idempotent replies with safe cancellation and durable resume marker.
- [x] Integrate exclusive control tool boundary, waiting_input and original-tool-result resume.
- [x] Run focused tests and inspect diff.

### Task 2: Specialist snapshots (worker, disjoint new module)
Files: new specialist-profile.ts and tests. Main integrates delegate and effective profile calls.
Interfaces: specialistSpecSchema; resolveSpecialistProfile(baseProfile, session); buildSpecialistChildInput(parent, args); capability and scope checks.
- [x] Write and run snapshot/capability escalation tests.
- [x] Implement constrained, persisted specialist snapshots without global registration.
- [x] Main integrates all profile resolution and delegate entry points; test recovery.

### Task 3: Goal lifecycle (worker, disjoint new module)
Files: new goal-control.ts and tests. Main integrates into Loop and control tools.
Interfaces: initializeGoal, recordGoalUsage, getGoalState, checkGoalCompletion, buildGoalInstruction; operate on explicit data/store parameters, avoid importing loop/tool singleton.
- [x] Write and run goal budget/evidence tests.
- [x] Implement root budget and acceptance gates with no autonomous success on max_steps.
- [x] Integrate bounded continuation and completion tool; verify stop semantics.

### Task 4: Frontend controls/forms (worker)
Files: new AgentInteractionPanel.tsx and tests; existing SessionComposer.tsx, SessionWorkspace.tsx, session type/API/store/status helpers (avoid dirty files listed in initial manifest).
Interfaces: exact HTTP and metadata contracts in spec. Form reload comes from durable endpoint; supports submit/decline/cancel and plan save/revise/execute.
- [x] Test typed input, required fields, submit retries, plan actions and mode constraints.
- [x] Add mode selector and interaction/goal panels, refresh from runtime events.
- [x] Run focused frontend tests and typecheck.

### Task 5: Integration verification (main + scoped review)
- [x] Run native runtime and web focused regressions, typecheck and build.
- [x] Review cancellation/restart/permissions/parallel barriers and repair concrete issues.
- [x] Verify pre-existing dirty-file hashes or inspect overlapping changes.
- [x] Update checklist and report exact validation limits without claiming live E2E.


## Verification and delivery notes
- Implemented in the shared workspace on `codex/agent-plan-goal-hil`; unrelated concurrent workspace/settings changes are preserved.
- Existing AgentLoopRuntime owns execution. Goal observation is detached from SSE; explicit pause/stop propagates to native worker processes and descendants.
- Human forms and answer consumption are persistent; model tool call and result parts survive reopening the DB. Versioned plan approval freezes an execution scope used for evidence and read-cache validity.
- Specialist snapshots enforce both frozen assignment limits and current parent permissions. Writable specialists require pre-granted parent scope permission; otherwise the primary agent handles approval and execution. Specialist permission blockers return to the primary instead of opening an orphaned child dialog.
- New tool schemas serialize through the installed AI SDK into provider JSON schemas without a model/API call.
- API and Vite bundles build. Full typechecking has existing errors; comparison against the untouched source snapshot found no new backend diagnostics. Frontend worker likewise compared its diagnostics to the pre-edit baseline.
- Existing provider/config, browser-environment and Wiki failures were reproduced on the untouched source snapshot. See `/tmp/synax-agent-final-all.log` and `/tmp/synax-agent-all-baseline.log`; do not describe the full suite as green.
- No live database migration, backend restart, real-provider goal run or browser E2E was performed. New migration is applied on the next backend startup. Generated bundles alone do not mean the currently running server loaded these changes.


### Final focused checks
- Native runtime (excluding the two independently reproduced provider-configuration route failures): 54 files, 337 tests passed.
- Frontend focused checks: 7 files, 66 tests passed; the frontend worker additionally checked its eighth related file.
- API bundle and Vite production bundle passed; provider-facing schemas for all four control/delegation tools serialized successfully.
- Added real-process cancellation regression: a command group that ignores TERM cannot perform its delayed write after abort; an independent command remains alive. The actual agent-session-runner shutdown also terminates owned shell commands before exit. Process-manager waiting now observes the real exit event, not only cleared maps.
- Backend type diagnostics were compared against an untouched source snapshot: 35 distinct diagnostics both before and after, zero newly introduced diagnostics.
- Whole-repository baseline: 20 failing tests; after giving the edited browser API test its correct DOM environment, 17 pre-existing failures remain, with no new failing test names.

- Independent scoped review: permission revocation, detached-worker pause, current-plan proof boundaries and normal controlled command shutdown have no remaining reported findings.
