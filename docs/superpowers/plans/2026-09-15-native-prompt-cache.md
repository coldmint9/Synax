# Native Prompt Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Preserve existing workspace changes.

**Goal:** Stabilize Native request prefixes and measure provider cache usage without guessing missing data.
**Architecture:** Shared source-aware usage normalization; immutable step reminders and deterministic references; protocol-specific cache policy and metadata-preserving gateway conversion; fingerprint-only diagnostics.
**Tech Stack:** TypeScript, AI SDK 7/provider v4, Vitest, SQLite metadata.
**Spec:** docs/superpowers/specs/2026-09-15-native-prompt-cache-design.md

## Global Constraints
- Do not change node_modules, existing unrelated changes, compression thresholds, default retention, CLI/ACP request construction or server-side authorization.
- Never infer server cache hits from local prefix fingerprints; unavailable measurements remain unknown.
- Tests use mocked transport; live requests require existing authorization and explicit opt-in.
- Preserve message/content providerOptions and signed reasoning verbatim.
- Implementation branch: codex/native-prompt-cache. Shared checkout is retained to preserve the user's existing concurrent runtime edits; scoped workers own disjoint files. Do not reset/stash this checkout.

## Task 1: Source-aware usage
**Files:** Create llm-runtime/usage.ts, middleware/usage.ts, __tests__/usage.test.ts. Modify hook-callbacks.ts, llm-hooks.ts, loop-model-stream.ts, usage-projection.ts, acp-usage.ts, web/src/lib/api/agentRuntime.ts, session-stats.test.ts.
**Interfaces:** `normalizeUsage(value: unknown, context?: UsageContext): NormalizedUsage | undefined`; normalized record retains legacy aliases and a versioned availability/provenance envelope. `applyUsageMiddleware(model, context)` captures whitelisted raw usage per attempt before SDK synthesis.
- [x] Add regression: `expect(normalizeUsage({inputTokens:10000,inputTokenDetails:{cacheReadTokens:0},raw:{prompt_tokens:10000,prompt_cache_hit_tokens:8000}})?.cachedInputTokens).toBe(8000)`.
- [x] Run `npx vitest run api/services/llm-runtime/__tests__/usage.test.ts`; record initial failure.
- [x] Implement own-property selection of raw standard fields before compatible aliases, validate finite nonnegative integers, distinguish ambiguous legacy zero from known zero, merge Anthropic streaming usage fragments without double addition.
- [x] Use the same result for hooks and Native persistence; read old ACP/CLI records through compatibility parser, preserve context-window semantics.
- [x] Aggregate cache totals, coverage and matched numerator/denominator; assert `rate = sum(matchedRead)/sum(matchedInput)` with differing input sizes.
- [x] Run usage and session-stats suites; inspect only owned changes.

## Task 2: Stable references and runtime snapshots
**Files:** loop-prompt.ts, synax/synax-mode-prompt.ts, synax/synax-agent.ts where needed; create runtime-request-snapshot.ts; modify loop-runtime.ts, loop-model-messages.ts, context-projection.ts only where needed; prompt-composition, loop-prompt-synax, loop-runtime, context-projection tests.
**Interfaces:** `projectReferenceBlocks(context)` uses source identity/content hash; `buildSynaxRuntimeState(context): string`; versioned `runtimeReminder` metadata with immutable exact content; history builder prepends saved reminder to its assistant exchange.
- [x] Add assertion that changing only context block IDs and insertion order does not change `buildLoopSystemPrompt`.
- [x] Run `npx vitest run api/services/agent-runtime/__tests__/prompt-composition.test.ts api/services/agent-runtime/synax/__tests__/loop-prompt-synax.test.ts`.
- [x] Replace unstable block IDs with explicit stable source fields and SHA-256 fallback, deterministic tie-breakers; retain storage IDs.
- [x] Split saved plans/objective/evidence/Work from static mode/permission rules. Append them to the existing user reminder.
- [x] Persist reminder after final projection/budget checks, before dispatch; reuse current snapshot and exclude it from historical replay to prevent duplication.
- [x] Reconstruct earlier reminders before assistant messages, following actual consumed queued-input identities; old metadata is optional, excluded steps omit reminders.
- [x] Assert `nextConversation.slice(0, previousConversation.length)` equals previousConversation for three steps with unchanged config; cover resumed requests and old sessions.
- [x] Keep latestSystemPrompt static, count all reminder tokens and preserve existing final context_blocked guard.
- [x] Run runtime/context/mode control suites; inspect diff for retained child timeout changes.

## Task 3: Provider caching and metadata
**Files:** Create llm-runtime/cache-policy.ts and __tests__/prompt-cache-wire.test.ts; modify types.ts, prompt.ts, providers/provider-strategy.ts, provider-strategy.test.ts, responses-protocol.test.ts. Pipeline integration owned by coordinator.
**Interfaces:** `applyPromptCachePolicy(messages, options)` returns copied messages with legal markers; optional stable boundary identifiers from Native metadata. `supportsCacheControl` consults actual protocol/adapter and options.promptCaching.
- [x] Capture actual Anthropic SDK request body and assert no more than four cache_control fields, including tools/system/history.
- [x] Run wire/provider strategy suites to demonstrate missing behavior.
- [x] Preserve message-level system/conversation providerOptions and content options with immutable copies; no change to signatures/media/tool pairing.
- [x] Implement auto/on/off capability without hostname/provider-id guessing; off/unsupported remove cache fields only, keep other metadata.
- [x] Keep system and previous eligible history anchor before latest reminder, add current eligible historical end; retain old anchor across 20+ new blocks.
- [x] Assert no marker on thinking and no Anthropic cache fields on OpenAI Chat/Responses; store:false and explicit responseOptions unchanged.
- [x] Run provider-strategy, prompt-cache-wire, responses-protocol suites.

## Task 4: Diagnostics and integration
**Files:** Create llm-runtime/cache-diagnostics.ts, scripts/diagnose-prompt-cache.ts, docs/integration/prompt-cache-diagnostics.md; integrate pipeline.ts and loop-runtime.ts; add diagnostic/request tests.
**Interfaces:** `fingerprintRequest(messages, tools)` returns block kind/hash/length; `compareRequests(previous,current)` returns first change and stable prefix length; no prompt bodies persisted. Records carry provider/model/source/phase and usage availability.
- [x] Assert changing reminder changes only tail fingerprint; repeat identical requests and assert no change; assert serialized diagnostics do not contain fixture secrets.
- [x] Instrument Native and adapter boundaries; attach normalized usage only once per provider response, retain measured timing and unknown values.
- [x] Script drives real repository prompt builders/converters with captured transports, emits grouped local report; live mode explicitly opts into configured protocol samples.
- [x] Run `npx tsx scripts/diagnose-prompt-cache.ts` twice and compare stable hashes/scenario results, not timestamps.
- [x] Execute related Vitest suites and `npm run typecheck`, report pass/fail/unrun/pre-existing separately.
- [x] Inspect `git diff --check`, review full feature diff and preserve unrelated workspace changes; publish local report and live measurement instructions.

## Review ledger
- Design approved by user September 15, 2026.
- Baseline and final validation recorded in integration report; no production cache-rate baseline exists.
- Ruling: current checkout on feature branch rather than resetting/copying user changes; disjoint ownership prevents overlap with concurrent timeout work.

## Execution record (2026-09-15)
- Completed all four tasks in the existing checkout on codex/native-prompt-cache, preserving unrelated UI and child-timeout edits.
- Independent review led to three additional fixes: legal mixed TTL ordering, explicit queued-input ownership, and serialized JSON/actual-schema budgeting. Added persisted prefix anchors and invalidation status.
- Baseline API typecheck passed. Initial runtime baseline had three failures; expanded validation also identifies unchanged Goal/Work assertion mismatches. Full commands and results are recorded in docs/integration/prompt-cache-validation-2026-09-15.md.
- Local HTTP capture ran twice with 63 requests each and identical fingerprints; final-code capture repeated successfully. An existing authorized Responses connection was subsequently measured with three synthetic diagnostic requests; see the validation report.
- Ruling: feature edits remain uncommitted to avoid bundling existing mixed-file user changes; the earlier design-only commit remains intact.
