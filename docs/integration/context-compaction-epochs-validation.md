# Context epoch implementation validation

## Status

Implemented on `codex/context-epochs`, based on `dab67d0` (the previous Native prompt-cache work). Feature changes remain uncommitted; no merge or push was performed. The workspace was clean at the start of this task.

This release uses deterministic local, source-linked extraction and cached drafts, not an LLM summarizer or a new provider-native compaction API. It changes Native projection, immutable first-emission receipts and additive metadata. It does not change permission decisions, plan/goal acceptance, external CLI/ACP request construction, provider cache keys or retention defaults.

## Executed validation

| Check                                                                     | Result                                                                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Initial API typecheck                                                     | Passed                                                                                                 |
| Initial four-file runtime/context/control baseline                        | 44 passed; 3 existing loop-runtime failures                                                            |
| Initial epoch regressions before implementation                           | 2 expected failures observed                                                                           |
| Final related Vitest selection                                            | **520 passed, 6 failed, 526 total; 40 files**                                                          |
| Final API `npm run typecheck`                                             | **Passed**                                                                                             |
| Final Web `npx tsc -p web/tsconfig.app.json --noEmit --incremental false` | **Passed**                                                                                             |
| Whitespace/diff checks                                                    | Passed                                                                                                 |
| Final ownership/media/context focused run                                 | **23 passed**                                                                                          |
| Repeated 72-step A/B/C trace                                              | Deterministic non-timing request metrics across repeated runs; final run matched earlier release trace |
| Independent scoped reviews                                                | All reported findings resolved, including the final snapshot-owned queued-media case                   |
| IDE build                                                                 | Unavailable: Synax is not an open JetBrains project; CLI typechecks used                               |
| Entire repository test suite / production bundle                          | Not run; affected and adjacent suites were selected                                                    |
| Real-provider fees, cache hits, closed-loop task quality                  | **Not measured**; this task sent no provider/model requests                                            |

### Final test command

```sh
npx vitest run --maxWorkers=2 --testTimeout=20000 \
  api/services/agent-runtime/__tests__/context-*.test.ts \
  api/services/agent-runtime/__tests__/tool-context-receipt.test.ts \
  api/services/agent-runtime/__tests__/loop-model-messages.test.ts \
  api/services/agent-runtime/__tests__/loop-model-stream.test.ts \
  api/services/agent-runtime/__tests__/loop-runtime.test.ts \
  api/services/agent-runtime/__tests__/session-stats.test.ts \
  api/services/agent-runtime/__tests__/control-boundaries.test.ts \
  api/services/agent-runtime/__tests__/goal-control.test.ts \
  api/services/agent-runtime/__tests__/work-runtime.test.ts \
  api/services/agent-runtime/__tests__/permission-policy.test.ts \
  api/services/agent-runtime/acp-engine/__tests__/acp-usage.test.ts \
  api/services/agent-runtime/synax/__tests__ \
  api/services/llm-runtime/__tests__
```

### Existing failures kept visible

The initial baseline reproduced these three loop-runtime assertions:

1. A goal at the step limit expects session `completed`, while existing behavior returns `paused`.
2. Cooperative closing expects an additional shell call to be denied, while the existing runtime allows it.
3. The closing-tool test expects `bash` absent, while the existing tool set exposes it.

The expanded selection also retained the three failures already documented in the preceding prompt-cache task:

4. A Goal instruction assertion expects the phrase “session and model limits”, absent from the unchanged instruction builder.
5. The “all TODOs done” Work test expects a closing-error string; existing `toolError` returns null.
6. The “stalled steps” Work test likewise expects a closing-error string.

Goal/Work implementation and these Goal/Work tests are unchanged by this patch. We did not change authorization/cooperative-closing behavior or weaken assertions to make the suite green.

## Local trace results

See `context-compaction-epochs-replay.json`. It contains one final deterministic 72-request trace per strategy, using an isolated temporary database and prohibited network calls. A/B use explicit frozen reference projectors; C uses the actual new projector and immutable receipts.

| Strategy                                | Compactions | Total estimated input tokens | Peak estimated input | Last-request visible decision markers | Total local projection time |
| --------------------------------------- | ----------: | ---------------------------: | -------------------: | ------------------------------------: | --------------------------: |
| A: former threshold/truncation          |          57 |                    3,945,360 |               63,969 |                               13 / 71 |                     7.159 s |
| B: hysteresis with legacy summary       |           6 |                    4,704,261 |               94,641 |                               16 / 71 |                     6.957 s |
| C: structured context epochs + receipts |       **3** |                    4,192,714 |               91,560 |                           **71 / 71** |                 **3.991 s** |

All three retained the synthetic user prohibition in visible context. Other integration tests separately verify legacy queued constraints across full/partial cuts, before/after corrections and Work transitions; the single trace's marker count is not a comprehensive semantic evaluation.

New-policy cut requests were **35, 49 and 65**. `requestsPerCompaction` is the ratio of total requests to cuts, not the average interval between adjacent commits. The exact request indices are included to avoid confusing that ratio with epoch length.

First-emission receipts avoided 4,088,530 UTF-16 characters in this fixture's selected tool-result views. That is not a token count, and bytes already discarded by a tool before storage cannot be recovered.

### What the trace supports—and does not

- It supports a substantial reduction in checkpoint replacement frequency for this trace.
- It supports better retention of these specific synthetic decision markers.
- It supports deterministic repeatability of input estimates, action decisions, cuts and marker visibility.
- It does **not** show a reduction in every metric: C's total estimated input is slightly higher than A's. Keeping a longer stable context can cost more if the actual provider cache does not hit.
- JSON cost units use explicitly hypothetical ordinary price 1/M, read 0.1x and write 1.25x, maximal local prefix eligibility and no TTL eviction. They are **not** measured currency charges or provider cache-hit tokens.
- Fixed trajectories cannot reveal task detours, additional tool calls, forgotten requirements in unseen workloads or actual success rate. No production savings percentage is claimed.

## Performance refinement

The first correct epoch implementation took about 89.6 seconds of local projection time on this fixture. Profiling-by-comparison exposed unnecessary repeated processing of verbose raw logs.

The final version:

- Reuses prepared segments only when their source fingerprint matches.
- Keeps an existing invisible draft below high watermark rather than rebuilding it each request.
- Extracts from the immutable, already-model-visible receipt on eligible v2 steps instead of processing the full raw log again.
- Packs prioritized whole entries using cached per-entry estimates and validates the final complete rendering, avoiding a quadratic full-snapshot/tokenization loop.
- Preserves receipt line locators, including offsets after private-markup exclusion.

The final repeated run's projection time was about 4.0 seconds. Local timing is hardware/workload dependent, not provider TTFT.

## Review-driven safeguards

- ID-preserving SQL upsert prevents metadata preparation from moving old step row identities.
- Shared ownership resolution covers explicit input boundaries, saved snapshots and legacy timestamps.
- Full-run cuts retain required legacy queue text; partial cuts suppress an already represented text input rather than reissuing it as a fresh user message.
- Before/after corrections and same-boundary input order survive memory extraction and later epochs.
- Public user XML remains literal; tag spelling does not turn it into provider-private reasoning.
- Every committed memory advertises an exact checkpoint index locator that survives Work transitions.
- Snapshot-owned queued media in partial cuts retains an asset locator and original message pointer, even when its text ID is marked summarized.
- Failed candidates leave the active Work checkpoint unchanged; required content/pins are not silently discarded to satisfy a budget.
- Restored sessions can recover epoch identity from their checkpoint without inventing a warm-cache age.

## Rollout guidance and remaining limits

Defaults remain configurable engineering starting points. The 120k effective-window cap is not a proven quality optimum. A lower cap can keep the high watermark nearer the previous 64k region for a more conservative rollout. Confirm actual cache read/write coverage and prices before enabling cost-based decisions; unknown values are not zero.

A very large set of mandatory user text can exceed `memoryTokenBudget`. The implementation deliberately refuses to truncate those requirements. Operators may need a larger memory budget, attachments/source references instead of large pasted data, or a smaller task scope.

The next evaluation should use paired closed-loop Native tasks with the same model, tools and permissions, measuring successful-task total cost, completion rate, repeated work, retrieval calls and latency. Test each real protocol path independently. Keep provider-native compaction as a separate comparison rather than assuming opaque states are portable.
