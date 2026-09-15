# Cache-aware Native context epochs

## Scope

Native context projection now uses stable epochs and deferred, source-linked batch compaction. This is an additive replacement for threshold-chasing `summary.slice(-16000)` projection, not a new provider API or an LLM that rewrites memory every turn.

The first implementation deliberately uses deterministic local extraction. Preparation is synchronous local work with cached segments/drafts, **not** an asynchronous paid summarizer. A prepared candidate is outside the prompt until committed. Provider-native compaction remains a possible future backend; it is not silently enabled.

No tool permission, plan approval, goal acceptance, cache retention/key, or external CLI/ACP request-construction rule is changed.

## Lifecycle

1. Below preparation watermark, rebuild the current immutable checkpoint plus append-only recent history.
2. At preparation watermark, extract closed steps into source-linked segments and build an invisible draft. Existing drafts are retained below high watermark rather than re-summarized every request.
3. At high watermark, revalidate source fingerprints and form a candidate targeting the low watermark. Selection occurs at batches of complete steps; recent and pinned steps remain raw.
4. Require useful reclaim, an adequate stable-request interval and—when explicitly configured—an amortization horizon. Missing cost data remains unknown.
5. Commit one new checkpoint atomically. Archive the replaced checkpoint and persist an exact full-index locator on the new boundary step.
6. Freeze the new checkpoint and append subsequent turns. Another cut is a new epoch, not an incremental rewrite of yesterday's summary on every turn.

The previous provider-cache mechanism remains in use: prepared media/compiled tool-media anchors are checked in the same representation at dispatch. Compaction legitimately invalidates part of the old prefix; this design aims to amortize those replacements, not claim that suffixes are independently cacheable.

## Default policy and configuration

Set server/session `sessionMetadata.contextCompactionPolicy`. Missing fields use these defaults:

```json
{
  "effectiveWindowCap": 120000,
  "prepareRatio": 0.65,
  "highRatio": 0.8,
  "lowRatio": 0.5,
  "minStableRequests": 8,
  "minReclaimRatio": 0.2,
  "keepRecentSteps": 2,
  "memoryTokenBudget": 6000,
  "safetyTokens": 1024
}
```

These are configurable engineering starting points, not a proven optimal quality/cost setting for every model. In particular, a configured 1M provider window does not automatically mean a 1M working budget.

- `hard = contextLimit - outputReserve` is the physical request input ceiling.
- The working budget is capped by `effectiveWindowCap`, then reduced by safety headroom.
- Prepare/high/low are fractions of that working budget.
- Base safety and the extra positive-growth P95 margin are each capped at 10% of the effective window. Missing growth measurements do not become zero observations.
- `minReclaimRatio` applies to working-budget tokens, not a percentage of the raw transcript's character length.
- The cooldown counts distinct preceding request steps, never repeated calls to the projector.
- A changed model/static-context fingerprint resets the cache-stability interval; it never delays actual permission/tool/reference updates.

For a 200k model window and an 8,192 output reserve, the initial default budget is 118,976 tokens; high is approximately 95.2k and low approximately 59.5k before an observed-growth margin is available.

Hard pressure overrides optional cooldown/cost gates, but cannot commit a candidate above hard or with invalid mandatory content. Working-budget pressure may also bypass optional gates; a tiny cut that still cannot reach the working budget is deferred while physical room remains, avoiding a new form of threshold chatter.

`sessionMetadata.contextPinnedStepIds` can keep specified still-active raw steps from future cuts. Pinning an already compacted step does not retroactively rewrite the epoch; use `context.read` to reintroduce its evidence at the current tail.

## Economic gate

The optional inputs are explicit and use one currency:

```json
{
  "expectedRemainingRequests": 20,
  "pricing": {
    "cachedInputPerMillion": 0.1,
    "cacheWritePerMillion": 1.25,
    "summaryCost": 0,
    "retrievalCost": 0
  }
}
```

**These numbers are a hypothetical example, not prices inferred for the configured provider.** Do not copy them as a production pricing assertion. Token prices are per million; summary/retrieval costs are absolute amounts for the candidate.

The estimator assumes affected old history is warm and the horizon includes the first request after cutting:

```text
rebuild premium = affectedAfter × max(0, writePrice − readPrice) / 1,000,000
one-time cost = rebuild premium + summaryCost + retrievalCost
saving/request = (affectedBefore − affectedAfter) × readPrice / 1,000,000
break-even requests = one-time cost / saving/request
```

Stable prefix tokens are excluded from the affected region. Zero cached-read price does not manufacture a finite break-even. `economics.known` means the configured estimate inputs are present and representable; it does **not** mean actual server costs/hits were measured. With missing prices or horizon, optional high-watermark cuts use the space/gain/cooldown rules and report unknown economics. The gate is conservative: it can defer a cut, not opportunistically rewrite prefixes before the prepare/high lifecycle.

## Memory content and trust

Segments contain canonical entries for historical user requirements, decisions, observations, failures, tool execution status and next actions, with original IDs, field/paragraph references and digests.

- User requirements are preserved verbatim, including literal XML such as `<signature>`; syntax alone cannot turn a public user request into private reasoning.
- Assistant claims remain `assistant-unverified`; tool result text remains `tool-untrusted`.
- Only server tool status is labeled as execution status. A completed command is not proof that tests passed or that a goal is accepted.
- Thought/reasoning parts, provider metadata and signed/encrypted reasoning are not turned into summary prose.
- Whole entries are selected, not arbitrary character suffixes. Failures, decisions and requirements have priority over verbose observations.
- Required entries and source references that do not fit invalidate the candidate. The engine retains the old context while it fits, or reports `context_blocked`; it does not erase requirements to force a smaller request.
- Subsequent checkpoints assemble canonical entries, not recursively summarize the previous rendered narrative. Eligible v2 steps reuse their immutable model-visible receipt with exact line references rather than repeatedly mining the full raw log.

Optional observations can still be omitted. Their count/checksum and a bounded reference index are recorded, so this is auditable lossy compression, not a claim of lossless semantics. Original stored tool/message/step records remain available.

## First-emission tool receipts

New Native steps are marked `contextProjectionVersion: 2`. Where `context.read` is available, sufficiently large safe text/log results can get an immutable receipt before their first appearance in model history.

- Default cap: 6,000 **UTF-16 characters**, not tokens.
- Require at least 20% and 512 characters of reduction.
- Preserve execution status, relevant late errors/warnings/stack lines, the command and stdout/stderr truncation flags for the known bash result schema.
- Include an exact `context.read` tool-result locator with pagination guidance.
- Unknown structured payloads, opaque encodings and content-part-bearing/multimodal results keep the existing projection.
- Old steps are not retroactively reformatted. Once a new receipt is stored, later requests replay its exact text/type.

The existing bash tool can truncate output before storage. A receipt cannot recover bytes already discarded there; it advertises the full **stored result** and preserves that truncation warning.

## Durable metadata and retrieval

- `step.metadata.contextMemorySegment`: prepared canonical segment.
- `step.metadata.contextMemorySourceFingerprint`: fingerprint used to reuse extraction only when its source is unchanged.
- `sessionMetadata.contextCompactionState`: active epoch, stability baseline, static-context identity, optional invisible draft.
- `work.checkpoint.memory/epoch`: committed immutable memory snapshot.
- Boundary-step `contextCheckpointIndex`: stable full-index lookup across Work transitions, even when old steps have no Work association.
- Boundary-step `contextCheckpointArchive`: the replaced checkpoint, for legacy summary/history recovery.
- Current request `step.metadata.contextCompaction`: body-free action/reason, epoch, thresholds, estimates, reclaim and configured economic availability.

Committed summaries include an exact locator:

```json
{ "kind": "checkpoint", "id": "BOUNDARY_STEP_ID", "offset": 0, "limit": 6000 }
```

Pass that to `context.read`; page with `offset` when needed. `tool`, `step`, `message` and `work` retrieval remain supported and session-tree scoped. Current Work/goal/permission state still comes from authoritative runtime state, never from a historical checkpoint. Covered queued text is not reissued as a new user message, while queued media keeps its asset and original-message locators across partial cuts.

Steps are updated using an ID-preserving SQL upsert, so preparing metadata on an old step no longer changes its row identity/order. Legacy chronological reconstruction uses run order plus step index, not mutable historical rowids.

## Reproduction and evaluation

```sh
npx tsx scripts/diagnose-context-compaction.ts --steps 72 --out .tmp/context-epochs/run-1
npx tsx scripts/diagnose-context-compaction.ts --steps 72 --out .tmp/context-epochs/run-2
```

The script creates its own temporary SQLite database, forbids network/provider calls, and cleans up only that owned database directory. It does not read or modify the production session database.

It compares:

- A: the frozen pre-change 64k threshold/reference implementation;
- B: the same legacy summary representation with high/low watermarks;
- C: the actual epoch projector with structured memory and first-emission receipts.

It reports cut frequency, estimated input size, local projection time, synthetic decision-marker visibility, retained user constraints, and explicitly hypothetical input-cost units. Local common-prefix estimates are not provider cache hits. Fixed trace replay cannot measure extra tool loops caused by compaction or successful task completion; closed-loop model evaluation is still required before claiming production savings.

See `context-compaction-epochs-validation.md` for the executed checks, current trace results and known pre-existing failures. No fixed improvement percentage or optimal threshold is promised.
