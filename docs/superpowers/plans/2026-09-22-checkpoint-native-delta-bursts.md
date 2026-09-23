# Bounded native delta bursts plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans with test-first execution.

**Goal:** Reduce actual native loop token-event/undo amplification (including current v2 sessions), not just expose a batch API used only by fixtures.

**Architecture:** Coalesce adjacent text/thought deltas immediately before AgentLoopRuntime persists them. Preserve type/control/retry boundaries and text exactly. Flush at 20ms, 8KiB or 64 upstream chunks. Keep one upstream next() in flight, at most 64KiB incoming delta, and 8MiB per-process aggregate reservation; fail explicitly beyond limits, never truncate. A per-step AbortController cancels prefetched reads when the consumer breaks/force-injects; the source factory receives that combined signal.

**Tech Stack:** Node async iterators, existing LoopModelStreamEvent types, Vitest fake clocks.

- [x] RED tests for adjacent grouping, control/type boundaries, Unicode, exact output, deadline flush, partial-output-before-error, abort/early-return cleanup and over-limit rejection.
- [x] Implement `loop-delta-bursts.ts` with bounded reservation and one pending read; no durability acknowledgement in the helper.
- [x] Wrap the real loop generateStep call, keeping individual stream API/native reasoning protocol unchanged and persisting each emitted burst before yielding it outward.
- [x] Verify a real AgentLoopRuntime fixture emits fewer persisted event rows without altering the final answer, plus existing loop-model/loop-runtime/journal tests.
- [x] Record limitations: control messages and full provider response construction still need their own resource limits; module reservation is per process, not a system-wide memory cap; v3 full execution/UI/files/migration remain incomplete.

Verification: RED native fixture persisted 1,000 events; GREEN persists 16 message-delta events and 16 corresponding undo entries with exact 1,000-byte final content. Deadline, Unicode, cancellation, error flushing and 8MiB aggregate reservation tests PASS. Final isolated combined run: 28 files / 230 tests PASS; API typecheck PASS. Full versioned execution/UI/files/migration remain unfinished.
