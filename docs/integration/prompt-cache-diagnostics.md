# Native prompt cache diagnostics

## What changed

- Native reference blocks use stable source identity (or a SHA-256 content identity), never freshly generated `acblk` IDs. Storage IDs and reference lookup are unchanged.
- Work, saved plan/goal state, evidence and step/failure notices are sent in a final user runtime reminder. Mode/permission rules remain in system and are enforced by the server.
- Each sent reminder is persisted as `step.metadata.runtimeReminder` and replayed before its assistant response. Explicit consumed-step ownership and queue IDs avoid equal-timestamp reordering, including mixed legacy/snapshot history. Legacy steps without snapshots use the existing projection. Compression removes reminders with their whole steps.
- The gateway preserves message/content provider options. Anthropic gets stable-system, previous-history and current-history boundaries, within a four-marker budget including existing markers. Thinking/signatures are not edited. OpenAI Chat/Responses keep their routing and response controls, including Native `store:false`.
- A shared versioned usage normalizer records source and field availability; it is reused by hooks, Native persistence, auxiliary calls, ACP/CLI compatibility readers and session statistics.

## Connection capability

Use the existing provider connection's options object:

```json
{ "promptCaching": "auto" }
```

`auto` is the default for the native Anthropic Messages adapter. `on` explicitly enables supported Anthropic connections; `off` disables the policy. Provider names/domains are not capability checks. Neither `on` nor `auto` sends Anthropic parameters to OpenAI protocols. `request.cacheControl: false` also disables markers. `promptCaching` is consumed by the gateway, not sent as a provider API parameter.

Compatible explicit 1h/5m markers are preserved; lower-priority TTL conflicts are dropped rather than producing an illegal ordering or silently upgrading default markers to paid 1h.

No compression threshold, OpenAI cache key, or retention default has changed. Existing explicit response options remain supported.

## Usage semantics and reading old sessions

Normalized records contain `normalization.version = 1`, per-field known/unknown status, chosen source and raw field presence.

1. A valid raw standard field wins, **including an explicit zero**.
2. If the standard field is absent, known compatible fields such as `prompt_cache_hit_tokens` can supply cache read.
3. SDK-synthesized zero cannot override captured raw usage. Missing, invalid or ambiguous legacy values remain unknown.
4. Anthropic raw uncached input plus read/write is totaled once. Already-normalized input is not increased again.
5. Legacy records are parsed on read, never rewritten or backfilled with guesses.

Existing `usage.self/tree` totals remain compatible. Added cache write, availability counters, explicit step/auxiliary subgroups, `cacheInputMatched`, `cacheReadMatched` and `cacheReadRatio` distinguish unknown statistics from a measured zero. The rate uses only requests with both input and cache read known:

```text
sum(matched cache read) / sum(matched input total)
```

It is not an average of step percentages. Zero or unavailable matched input yields a null rate. Overall legacy numeric totals can still be zero when no sample is known; always read their coverage alongside them.

## Enable diagnostics for Native requests

Start the existing application/API process with:

```sh
SYNAX_PROMPT_CACHE_DIAGNOSTICS=1 npm run dev:api
```

Diagnostics are off unless this variable is `1`. Reminder snapshots and source-aware usage are part of normal operation regardless of the diagnostic switch.

With diagnostics enabled:

- `step.metadata.runtimeReminder.historyAnchor` persists a marker-free historical-prefix fingerprint. It is captured after media hydration and tool-media compilation, through an awaited pre-dispatch callback. The following request validates it in the same representation before reusing the old boundary; `requestComposition.historyAnchorStatus` distinguishes matched, changed, evicted and unavailable anchors.
- `step.metadata.cacheDiagnostics` holds Native boundary block fingerprints/byte lengths, source, cold/continuous/post-compaction phase, first changed block and reminder token estimate.
- `step.metadata.providerMetadata.synax.cacheDiagnostics` holds the adapter boundary fingerprints and measured duration/first content-token latency where available.
- `step.metadata.providerMetadata.synaxUsage` contains whitelisted protocol usage evidence, not raw response text.
- `latestSystemPrompt` continues to mean static instructions plus references, not the complete request. `requestComposition` and `runtimeReminderTokens` describe the remaining request state. Compression and the final guard use serialized JSON tool outputs and actual active tool schemas, not the old tool-count constant; these are text/schema estimates, not provider-billed token counts.

No new full prompt or tool-result logs are generated by diagnostics. Existing application logs and the ordinary persisted conversation have not been rewritten. Fingerprints can still correlate content, so treat exported reports as internal data.

## Reproducible local capture

From the repository root:

```sh
npx tsx scripts/diagnose-prompt-cache.ts --out .tmp/prompt-cache/first
npx tsx scripts/diagnose-prompt-cache.ts --out .tmp/prompt-cache/second
```

Default behavior uses only a loopback HTTP stub, actual gateway/SDK serialization and synthetic prompts. Each run sends 63 text-mode requests: seven fixtures × three protocols × three consecutive requests. Fixtures cover no references, Code Map/Wiki, growing Work evidence, saved/approved plan state, 20+ newly appended history blocks, whole-step compression representation and serialized history recovery.

The script also runs focused **real Native runtime** regression tests covering three-request prefix capture, immutable reminder restoration, equal-timestamp input queues and actual context projection/compression. The fixture conversation builder is not presented as a substitute for these runtime tests. `--skip-regressions` omits this subprocess and marks it not-run.

Outputs:

- `report.json`: block fingerprints, differences, marker counts, source/phase groups, normalized usage and availability.
- `report.md`: readable summary.

Fixture cache counts deliberately exercise standard zero and raw-only `8000/10000`. **These are simulated provider responses, not real cache hits.** Local timings measure loopback/SDK overhead; text-mode first-token latency and unavailable cost remain null.

To compare deterministic results, exclude timestamps/latencies and compare each measurement's `request`, `comparison` and `localWire` fingerprints. A successful comparison proves repeatability of local requests, not provider-side token reuse.

## Read an existing session without network traffic or migrations

Pass the explicit existing database path and session ID:

```sh
npx tsx scripts/diagnose-prompt-cache.ts \
  --session SESSION_ID --db /absolute/path/to/context.db \
  --out .tmp/prompt-cache/session
```

This opens SQLite **read-only**, selects the requested session and descendants plus auxiliary usage, and does not initialize/migrate the application database. It groups main/subsession/auxiliary requests separately. Missing historical provider/model/phase/timing data remains `unknown` or null; enabling diagnostics now cannot recreate old measurements. Auxiliary rows without persisted provider/model identity stay in an unknown-identity auxiliary group.

Only counts, normalization metadata and validated fingerprints are exported from usage; arbitrary historical usage fields are not copied to the report. No new model requests are issued in this mode.

## Optional real-provider sample

A three-request synthetic sample was run against the existing authorized Responses connection; results are in the validation report. Anthropic had no available credential and no separate Chat connection was configured, so those live protocol paths remain unmeasured. To repeat against an authorized/configured connection explicitly:

```sh
npx tsx scripts/diagnose-prompt-cache.ts \
  --live --model 'EXISTING_PROVIDER/MODEL' --out .tmp/prompt-cache/live
```

This sends three small-output synthetic requests using that connection's existing settings. These standalone diagnostic calls are classified as auxiliary, not production Native main-session traffic. It does not send repository content and does not accept API keys on the command line. Repeat for each authorized protocol/model path you want measured. Model/configuration errors fail visibly; a provider-call failure is exported with unknown usage and a nonzero exit code, and stops additional samples. Absence of a live report is not a zero-cache observation.

The stable synthetic reference is long enough to probe caching on many models, but minimum length, TTL, proxy behavior, pricing and thinking rules can differ. A cold sample may still encounter an existing provider cache, and matching wire bodies do not guarantee a hit. Use only reported usage to determine cache read/write; unavailable cost and first-token timing stay null. For streaming Native latency, use recorded session diagnostics instead of text-mode samples.

## Validation and follow-up

See `prompt-cache-validation-2026-09-15.md` for executed checks, pre-existing failures and local results. Existing permission/mode/goal controls remain authoritative; historical reminders and retrieved evidence cannot authorize execution.

Do not tune compression watermarks, `promptCacheKey` or retention from simulated rates. Collect authorized provider samples first, split cold/continuous/post-compaction and main/subsession/auxiliary requests, inspect coverage and actual latency/cost, then decide whether a second optimization batch is justified.
