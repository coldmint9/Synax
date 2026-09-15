# Native prompt-cache validation — 2026-09-15

## Delivery status

Implemented on `codex/native-prompt-cache`. Feature code is left uncommitted so existing mixed-file user changes are not bundled into a commit. Existing UI/style/route changes and the child-timeout changes are retained. No CLI/ACP request construction, compression thresholds, retention defaults or cache keys were changed.

The implementation and new regressions are complete. **The broader selected regression run is not fully green:** 324 tests passed and 6 pre-existing assertions failed. No automatic merge or push was performed.

## Executed checks

| Check                                                                          | Result                                                                                                                                                      |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial API `npm run typecheck` baseline                                       | Passed                                                                                                                                                      |
| Initial four-file prompt/runtime/context baseline                              | 51 passed, 3 failed in loop-runtime                                                                                                                         |
| Added deterministic-reference/Work-in-system regressions before implementation | Two expected failures observed                                                                                                                              |
| Final selected Vitest run, 35 files                                            | **324 passed, 6 failed, 330 total**; 32 files passed, 3 failed                                                                                              |
| Final API `npm run typecheck`                                                  | **Passed**                                                                                                                                                  |
| Web `npx tsc -p web/tsconfig.app.json --noEmit --incremental false`            | **Passed**, no tsbuildinfo emission requested                                                                                                               |
| `git diff --check`                                                             | Passed                                                                                                                                                      |
| Local capture, final-code runs `release-1` / `release-2`                       | **63 requests each**, identical selected fingerprints/changes/anchors/wire fingerprints; focused Native regressions passed in both runs                     |
| Read-only session-report mode                                                  | Passed on a synthetic SQLite fixture: main/subsession/auxiliary separated, unknown auxiliary cache fields preserved, arbitrary private usage field excluded |
| Actual pipeline media preparation                                              | 3 tests passed: user image, compiled tool-media, persistence failure before transport                                                                       |
| Native three-request capture                                                   | Passed: unchanged system, complete serialized tool definitions and previous conversation prefix; persisted reminders/anchors match                          |
| Independent targeted re-review                                                 | All raised findings closed; not a full-suite-green claim                                                                                                    |
| JetBrains IDE build                                                            | Unavailable: this repository is not an open IDE project; CLI typechecks used instead                                                                        |
| Entire repository `npm test` / production bundle build                         | Not run; validation is the specified affected/adjacent suite selection                                                                                      |

The first broad concurrent run hit three default 5-second timeouts in filesystem/subprocess runtime tests. The final run below used two workers and a 20-second per-test ceiling: all three timed-out tests passed. No repository timeout configuration was changed.

### Final regression command

```sh
npx vitest run --maxWorkers=2 --testTimeout=20000 \
  api/services/llm-runtime/__tests__ \
  api/services/agent-runtime/__tests__/prompt-composition.test.ts \
  api/services/agent-runtime/__tests__/context-projection.test.ts \
  api/services/agent-runtime/__tests__/context-tokenizer.test.ts \
  api/services/agent-runtime/__tests__/loop-model-messages.test.ts \
  api/services/agent-runtime/__tests__/loop-model-stream.test.ts \
  api/services/agent-runtime/__tests__/loop-runtime.test.ts \
  api/services/agent-runtime/__tests__/session-stats.test.ts \
  api/services/agent-runtime/synax/__tests__ \
  api/services/agent-runtime/acp-engine/__tests__/acp-usage.test.ts \
  api/services/agent-runtime/__tests__/goal-control.test.ts \
  api/services/agent-runtime/__tests__/control-boundaries.test.ts \
  api/services/agent-runtime/__tests__/permission-policy.test.ts \
  api/services/agent-runtime/__tests__/permission-overrides.test.ts \
  api/services/agent-runtime/__tests__/work-runtime.test.ts
```

### Six existing failures left visible

The first three were observed before feature edits:

1. `loop-runtime`: “stops an active goal at the session step limit without failing the goal” expects session `completed`; current runtime returns `paused`.
2. `loop-runtime`: “blocks an unnecessary shell check after tracked work is done and accepts one closing decision” expects a shell tool denied; current cooperative closing behavior permits it.
3. `loop-runtime`: “only exposes closing tools without a full execution playbook” expects `bash` absent; current tool set still exposes it.

Expanded adjacent verification also found these three assertion mismatches. Both source and test files are unchanged by this work (`git diff --exit-code` on goal-control/work-runtime and their tests was clean):

4. `goal-control`: instruction test expects the phrase “session and model limits”, which is absent from the existing instruction builder.
5. `work-runtime`: “all TODOs done triggers a decision, not automatic success” expects a closing error string; current `toolError` returns null.
6. `work-runtime`: “stalled steps nudge, gate, and release the closing decision without blocking” likewise expects a closing error string.

These were not “fixed” by changing authorization/cooperative-closing behavior outside the cache task, and the tests were not weakened to hide them.

## Protocol/local results

`prompt-cache-local-2026-09-15.json` contains the final second local run. All token counts in that file are **fixture values** from a loopback stub, not real cache observations.

Coverage: no references; repeated Code Map/Wiki instance identities; growing evidence; saved/approved plans; 26+ appended conversation blocks; compression representation; serialized recovery. Actual Native tests separately exercise runtime request construction, explicit queue ownership (including mixed legacy history), saved reminders and whole-step context compression.

Additional wire regressions cover:

- Explicit standard cache zero versus raw-only compatible hit values and SDK synthetic zero.
- Raw/SDK Anthropic totals without double addition; ACP/CLI compatibility; auxiliary step aggregation.
- Message/content provider options, signed reasoning, encrypted Responses reasoning, tool pairing and media.
- Four-marker budget including existing tool/system/history markers; prohibited thinking blocks excluded.
- Mixed 1h/5m TTL ordering; conflicting lower-priority markers dropped without silently upgrading default TTL.
- Persistent historical-prefix anchor verification after media hydration/compilation; changed media bytes invalidate old reuse.
- JSON output and actual active tool-schema accounting in compression and final/prepared request guards.

Two final local runs had identical `request`, `comparison`, `historyAnchorStatus`, and `localWire` data after excluding timing and generation timestamps. This demonstrates repeatability, **not** a cache gain.

## Authorized real Responses sample

A read-only configuration presence check found an existing initialized Responses connection with a credential. Three synthetic requests were then sent using that connection, the configured `openai/gpt-6-astra` model, existing options, `store:false`, and a requested 32-token output ceiling. No repository content was transmitted.

These are **auxiliary standalone diagnostic calls**, not production Native session traffic. The report's source label was corrected after capture to reflect that; provider counts and timings were not changed.

| Logical phase             | Input total | Provider cache read | Cache write | Wall-clock call duration |
| ------------------------- | ----------: | ------------------: | ----------- | -----------------------: |
| First/cold-tagged request |       9,472 |               3,840 | Unknown     |                  2.727 s |
| Continuous request 2      |       9,505 |               3,840 | Unknown     |                  2.213 s |
| Continuous request 3      |       9,542 |               3,840 | Unknown     |                 14.511 s |

- Cache-read field coverage: 3/3 known.
- First-request reported rate: `3840 / 9472 = 40.54%`.
- Continuous weighted reported rate: `(3840 + 3840) / (9505 + 9542) = 40.32%`.
- Cache-write counts, costs, and text-mode first-token latency: **unknown**, not zero.
- The first/cold label means first request in this diagnostic sequence, not a purged/empty server cache. It already reported cache reads.
- The small sample **does not demonstrate an increasing cache-read rate or latency improvement**, and has no pre-change production baseline. Do not interpret it as a measured improvement from this patch.

See `prompt-cache-live-responses-2026-09-15.json` for the source-aware counts and fingerprints. These are the only real provider measurements in this delivery.

### Unmeasured paths

- Anthropic: no credential was available in the configured connection or standard environment variable; no real request sent.
- OpenAI Chat: no distinct authorized Chat connection was configured; no routing/configuration was changed to create one.
- Production Native main/subsessions, compressed live conversations, long-media live requests, and streaming TTFT: not measured. Local/wire regressions cover protocol behavior, not these real-world cache rates.

## Follow-up decision

Keep current compression watermarks, retention and cache-key defaults. The real sample is too small, and lacks a pre-change baseline, to justify a second optimization batch. First collect streaming Native diagnostics from authorized representative sessions, distinguish main/subsession/auxiliary and cold/continuous/post-compaction groups, and inspect coverage, matched denominators and actual latency/cost.

Usage fields unavailable in historical records remain unknown. Stable local prefixes and correct cache markers are prerequisites for reuse, not proof of server-side hits.
