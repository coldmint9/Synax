# Cache-aware Context Epochs Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for disjoint modules, then integrated review. Steps use checkbox tracking.

**Goal:** Replace threshold-chasing context truncation with deferred, evidence-addressable batch compaction that preserves stable request epochs.
**Architecture:** A pure policy selects prepare/keep/defer/commit using dual watermarks, minimum gain, cooldown and optional measured/configured costs. Immutable per-step memory segments are prepared out of band from the request and assembled into a versioned, source-linked checkpoint only at a commit boundary. Initial tool receipts apply only to new Native steps; old messages are not retroactively rewritten.
**Tech Stack:** TypeScript, existing SQLite step/Work/session metadata, Vitest; existing Native gateway and diagnostic interfaces.
**Spec:** User-approved research proposal in this task: stable cache epochs, deferred structured summaries, dual watermarks, break-even gate, immutable raw evidence and success/cost evaluation.

## Global Constraints
- Preserve current authorization, plan approval, goal acceptance, tool pairing and signed reasoning. No new provider APIs or price guesses.
- Raw messages/tool results remain unchanged and retrievable via context.read.
- Ordinary epochs are append-only; cache-invalidating replacements occur only on atomic checkpoint commits.
- Default summary construction is deterministic/extractive with source IDs, not an unverified paid LLM summarizer. An optional provider-native compressor is not needed for this first implementation.
- Store additive versioned fields only; no migrations or rewriting old records.
- Defaults are configurable engineering starting points, not asserted optimal model quality/cost values.
- Current branch is codex/context-epochs, derived from clean dab67d0. Do not reset others' changes or modify node_modules.

## Task 1: Pure policy and economic gate
**Files:** create `api/services/agent-runtime/context-compaction-policy.ts`, `__tests__/context-compaction-policy.test.ts`.
**Interface contract:**
```ts
interface ContextCompactionPolicy {
  effectiveWindowCap: number; prepareRatio: number; highRatio: number; lowRatio: number;
  minStableRequests: number; minReclaimRatio: number; keepRecentSteps: number;
  memoryTokenBudget: number; safetyTokens: number;
  expectedRemainingRequests?: number;
  pricing?: { cachedInputPerMillion: number; cacheWritePerMillion: number; summaryCost: number; retrievalCost: number };
}
resolveContextCompactionPolicy(value?: unknown): ContextCompactionPolicy;
contextWatermarks(policy: ContextCompactionPolicy, contextLimit: number, outputReserve: number, growthP95?: number): ContextWatermarks;
evaluateContextCompaction(input: {policy:ContextCompactionPolicy; watermarks:ContextWatermarks; currentTokens:number; candidateTokens?:number; stableRequests:number; stablePrefixTokens?:number}): ContextCompactionDecision;
```
- [x] Test default effective cap120000, prepare65%/high80%/low50%, cooldown8, minReclaim20%, keepRecent2, memory budget6000, safety1024. Invalid supplied numbers/ordering reject; missing fields default.
- [x] Implement `hard=C-output`, `budget=min(hard,cap)-safety` with bounded growth margin, minimums safe for small windows; all costs finite, no unit mixing.
- [x] Test prepare without commit; cooldown and small gain defer; budget/hard pressure overrides optional economic/cooldown gates but never permits an oversized candidate.
- [x] Test break-even using cached/write prices on affected tokens only, excluding stablePrefixTokens. Missing economic inputs stay unknown. Zero cached-read price cannot produce fake savings. Remaining horizon below break-even defers optional cuts.
- [x] Run `npx vitest run api/services/agent-runtime/__tests__/context-compaction-policy.test.ts`.

## Task 2: Evidence-linked immutable memory segments
**Files:** create `api/services/agent-runtime/context-memory.ts`, `__tests__/context-memory.test.ts`.
**Interfaces:**
```ts
buildContextMemorySegment(input: {step:AgentRunStep; parts:AgentRunPart[]; calls:ToolCallRecord[]; messages?:AgentRuntimeMessage[]}): ContextMemorySegment;
assembleContextMemory(input: {segments:ContextMemorySegment[]; previous?:ContextMemorySnapshot; legacy?:{summary:string;stepId:string}; epoch:number; tokenBudget:number; countTokens:(text:string)=>number}): {snapshot:ContextMemorySnapshot; summary:string; tokens:number; valid:boolean; errors:string[]};
```
Segment exposes `{version:1,stepId,fingerprint,entries}`; snapshot exposes `{version:1,epoch,entries}` plus source/index metadata as needed. Entries contain typed historical observations/decisions/failures/evidence/requirements/next actions, original references and digests. Never treat assistant claims as verified facts or authorization. Do not include thought/reasoning/signatures.
- [x] Test failures and decisions beyond leading text, exact queued-user constraints, tool status/evidence identifiers, deterministic fingerprints and immutability.
- [x] Prepare entries from complete paragraphs/sentences and structured tool outcomes, not a giant head/tail substring. Long content uses a reference rather than a clipped assertion.
- [x] Assemble from canonical entries and source segments, never repeatedly summarize prior summary prose. Deduplicate source identities, preserve required/pinned entries, record omitted source references within bounded index. If required facts cannot fit, return invalid; caller keeps history/blocks instead of silently erasing them.
- [x] Preserve opaque legacy summary via source-linked archival compatibility, without upgrading its statements to authority.
- [x] Run the memory suite.

## Task 3: First-emission receipts
**Files:** create `api/services/agent-runtime/tool-context-receipt.ts`, `__tests__/tool-context-receipt.test.ts`; coordinator integrates loop-model-messages/runtime.
**Interface:** `buildToolContextReceipt(record:ToolCallRecord,maxChars?:number): ToolContextReceipt | undefined`, returning `{version:1,sourceFingerprint,text,originalChars,projectedChars}` for large safe text/log payloads only.
- [x] Small results, opaque/multimodal/structured data without safe projection remain unchanged.
- [x] Retain command outcome, relevant error/warning lines, source identifiers and context.read retrieval instruction. No LLM calls; preserve raw record.
- [x] Tests retain late failure diagnostics, deterministic view, no signature mutation and no prompt-authority inference.
- [x] Run receipt suite; persist immutable receipt only on completed new Native steps, not old historical results.

## Task 4: Epoch preparation and atomic commit
**Files:** modify `context-projection.ts`, `work-store.ts`, `loop-runtime.ts`, `loop-model-messages.ts`; create focused epoch integration tests.
- [x] Add optional versioned checkpoint memory/epoch metadata and per-step segment metadata; store candidates outside model-visible Work prompt fields.
- [x] At prepare watermark, extract newly closed segments once and save them, without changing existing checkpoint summary or request prefix.
- [x] Select an eligible contiguous old prefix, keeping recent complete steps and every in-flight/pending exchange. Build one candidate aiming for low watermark. No partial-step/signature truncation.
- [x] Compute exact candidate text/schema estimate; consult Task1; on commit archive replaced checkpoint on its source boundary step, atomically save new Work checkpoint and epoch diagnostics. Never mutate current Work in memory before validation succeeds.
- [x] Persist stable epoch identity, commit reason/reclaimed tokens, unknown/known economics, growth measurements and stable request count. Count sent step identities, not repeated projection invocations.
- [x] Support old sessions/Work transitions; retained current authoritative requirements/evidence remain supplied through the existing tail reminder. New receipt snapshots do not change earlier sent tool output bytes.
- [x] Tests: three+ requests append-only inside epoch; prepared snapshot invisible; high-to-low batch cut; no threshold chatter; mandatory pressure; old/mixed sessions; queue/whole-step/signature pairing; unsuccessful candidate no checkpoint side effects; context.read retrieves archived evidence.

## Task 5: Evaluation and documentation
**Files:** new `scripts/diagnose-context-compaction.ts`, `docs/integration/context-compaction-epochs.md`, validation report and policy simulation tests.
- [x] Compare existing threshold, hysteresis-only, and proposed epoch policy on deterministic closed-step traces. Report frequency, reclaimed tokens, source coverage, known costs vs hypothetical estimates, and retrieval debt; never claim server hits from local hashes.
- [x] Use real Native/context projection tests for integration, not simulation alone. Mark closed-loop real-provider task quality evaluation unmeasured if not run.
- [x] Run targeted and adjacent Vitest suites, API/Web typechecks, git diff checks; separate pre-existing failures.
- [x] Review all changed behavior before delivery. Keep unrelated changes intact; no automatic merge/push.

## Decisions
- User explicitly authorized implementing the researched mechanism; no further design approval loop is required.
- The first implementation uses deterministic, source-linked memory, avoiding speculative per-turn model-summary costs and unverified provider-native API support.
- Numerical defaults are overrideable through server/session `sessionMetadata.contextCompactionPolicy`; historical text cannot update policy/authorization.

## Execution ledger
- Implemented in the shared checkout on codex/context-epochs; task started from clean dab67d0. No automatic commit/merge/push.
- Added context-epoch-store.ts and context-input-boundaries.ts to isolate persistent state and shared chronology.
- Fixed step upsert semantics after integration tests exposed rowid movement from INSERT OR REPLACE.
- Review fixes cover legacy required queue text, public XML literals, exact index discovery, before/after ordering, partial-cut duplicate suppression and queued media retention.
- Economics uses rebuild premium rather than charging a retained read twice; known means configured inputs, not observed provider savings.
- Performance refinement caches segments/drafts and reuses receipts; final 72-step trace has 3 cuts versus57 former-policy cuts, and local projection ~4s versus~7.2s. Total estimated input is slightly higher, so no universal cost win is claimed.
- Final related verification:520 passed/6 known pre-existing failures, API/Web typechecks passed. See docs/integration/context-compaction-epochs-validation.md.
- Closed-loop real-provider task quality and fees remain unmeasured; first implementation intentionally uses no paid summarizer.
