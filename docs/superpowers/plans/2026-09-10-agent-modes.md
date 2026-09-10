# Synax Agent Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

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
- [ ] Add failing interaction and policy tests.
- [ ] Persist validated requests and idempotent replies with safe cancellation and durable resume marker.
- [ ] Integrate exclusive control tool boundary, waiting_input and original-tool-result resume.
- [ ] Run focused tests and inspect diff.

### Task 2: Specialist snapshots (worker, disjoint new module)
Files: new specialist-profile.ts and tests. Main integrates delegate and effective profile calls.
Interfaces: specialistSpecSchema; resolveSpecialistProfile(baseProfile, session); buildSpecialistChildInput(parent, args); capability and scope checks.
- [ ] Write and run snapshot/capability escalation tests.
- [ ] Implement constrained, persisted specialist snapshots without global registration.
- [ ] Main integrates all profile resolution and delegate entry points; test recovery.

### Task 3: Goal lifecycle (worker, disjoint new module)
Files: new goal-control.ts and tests. Main integrates into Loop and control tools.
Interfaces: initializeGoal, recordGoalUsage, getGoalState, checkGoalCompletion, buildGoalInstruction; operate on explicit data/store parameters, avoid importing loop/tool singleton.
- [ ] Write and run goal budget/evidence tests.
- [ ] Implement root budget and acceptance gates with no autonomous success on max_steps.
- [ ] Integrate bounded continuation and completion tool; verify stop semantics.

### Task 4: Frontend controls/forms (worker)
Files: new AgentInteractionPanel.tsx and tests; existing SessionComposer.tsx, SessionWorkspace.tsx, session type/API/store/status helpers (avoid dirty files listed in initial manifest).
Interfaces: exact HTTP and metadata contracts in spec. Form reload comes from durable endpoint; supports submit/decline/cancel and plan save/revise/execute.
- [ ] Test typed input, required fields, submit retries, plan actions and mode constraints.
- [ ] Add mode selector and interaction/goal panels, refresh from runtime events.
- [ ] Run focused frontend tests and typecheck.

### Task 5: Integration verification (main + scoped review)
- [ ] Run native runtime and web focused regressions, typecheck and build.
- [ ] Review cancellation/restart/permissions/parallel barriers and repair concrete issues.
- [ ] Verify pre-existing dirty-file hashes or inspect overlapping changes.
- [ ] Update checklist and report exact validation limits without claiming live E2E.
