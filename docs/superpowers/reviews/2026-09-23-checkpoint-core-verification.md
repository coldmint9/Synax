# Checkpoint version core verification — 2026-09-23

## Status

Core storage/tree/head phase implemented and verified. **The overall goal is not complete.** No runtime session uses v3 yet; current UI rollback remains the legacy implementation. This is deliberately not an end-to-end acceptance report.

## Reproducible probe

```sh
node --max-old-space-size=128 --import tsx scripts/checkpoint-version-benchmark.ts --entries 10000,100000,1000000 --switches 1000 --output /tmp/synax-checkpoint-core-benchmark.json
```

Environment: Apple M4, 24GiB RAM, macOS kernel 27.0.0 arm64, Node v22.23.2. Each case uses a fresh temporary on-disk database, WAL, synchronous=FULL, 8MiB SQLite cache. Synthetic records have unique 256-byte content. Timings are warm, in-process measurements after generation, not cold-start/API/UI measurements. Output path must not already exist.

| Entries | Generation (s) | Switch p95/p99 (ms) | First index page p99 (ms) | Fork p99 (ms) | Sampled peak RSS (MiB) | DB / WAL (MiB) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 0.462 | 0.137 / 0.193 | 0.335 | 0.315 | 96.70 | 9.44 / 6.46 |
| 100,000 | 11.633 | 0.124 / 0.147 | 0.543 | 0.504 | 148.28 | 96.35 / 7.87 |
| 1,000,000 | 259.332 | 0.111 / 0.138 | 0.575 | 0.225 | 186.33 | 1054.57 / 7.87 |

- Each case performs 1,000 switches and 1,000 metadata forks; immutable object counts and bytes remain unchanged across those operations. Mutable control/idempotency metadata does grow and still needs budget/retention governance.
- First index pages return references, not all message contents or a rendered first screen. Root lookup does not replay history.
- No OOM occurred with 128MiB V8 old-space configured. Sampled peak RSS at 1M is 186.33MiB and sampled peak heap 44.90MiB. V8 old-space is not a hard native/process memory cap; the raw report separately records process resource-usage maximum and external allocations.
- Raw samples, maximum latencies, configuration and memory details are in `2026-09-23-checkpoint-core-benchmark.json`; do not replace these with the percentile summary alone.

## Storage gate: NOT passed

At 1M records, raw content is 244.14MiB but the main DB reaches 1054.57MiB before close (about 4.32×), with another 7.87MiB WAL. Logical admission reports 755.68MiB and does not enforce a physical 1GiB disk cap. The feature must NOT be enabled based on fast switches alone. No GC is implemented or exercised.

A separate 100k-record/100-switch diagnostic (`2026-09-23-checkpoint-core-storage.json`) used SQLite dbstat:
- Objects table: 54,837,248 bytes; normalized edges table: 22,716,416 bytes; reverse edge index: 22,659,072 bytes.
- The two edge structures consume about 45% of the DB. Hex-encoded identities are repeated in keys, tree payload and reference indexes.
- 100k raw chunk payloads total 25,600,000 bytes; 1,511 tree nodes total 12,386,562 payload bytes. Intermediate changed paths are not yet reclaimed.
- Next priority: reduce reference/identity encoding overhead and repeated small-event objects, implement safe bounded GC/pins, and measure live/allocated/WAL/temporary bytes rather than just logical counters. Correctness and finite quotas must remain enforced.

## Tests and source audits

- 34 real-libSQL core tests PASS: dedup, size/quota admission, corruption, nested atomicity, byte-bounded pages, multi-level sharing, randomized map comparison, root/epoch CAS, ownership, idempotency, independent forks and disk reopen.
- 2 benchmark CLI tests PASS, including finite workload rejection and explicit non-acceptance status.
- 37 existing tests across conversation-checkpoints, checkpoint-files, checkpoint-journal, checkpoint-recovery, checkpoint-maintenance and route conversation-history PASS in a generated temporary DATA_ROOT. Installed app and real data untouched.
- API `tsc --noEmit` PASS; standalone benchmark/script-test typecheck PASS.
- Non-test application imports of version-store currently exist only inside version-store itself. Migrations add empty tables; they do not convert or enable any session.

## Remaining requirements (all incomplete)

1. Physical storage and metadata budgets, safe concurrent GC, pins, WAL/temporary-file management, disk-full recovery and soak.
2. Bounded content streaming and staged writes, avoiding duplicate transient delta/full-text persistence.
3. Runtime/control-plane integration, writer fencing including child sessions, consistent versioned reads in context/search/export/usage and direct SQL consumers.
4. Async worker scheduling, API operation status, cancellation semantics and renderer first-page refresh.
5. File-manifest differences, Git/external-edit boundaries, durable compensation and process fences.
6. Bounded resumable v2 migration with checkpoint equivalence and old-program compatibility protection.
7. End-to-end cold/warm and concurrent 10k/100k/1M workloads, 10k-operation soak, crash/ENOSPC races, real peak RSS and storage acceptance.

## Direct-SQL integration audit

The initial wider table-name audit identifies 18 non-test consumers (not just the 9 returned by the initial messages/events-only search): execution-context, agent-stream-proxy, checkpoints guards/operations/state/store, interaction-service, media-assets, permission-timeout-sweeper, recent-workspace-reads, run-admission, run-coordinator, runtime-recovery, runtime-stream-writer, session-search, session-store, usage-projection and work-store. Their historical state and non-rewindable control state must be explicitly separated before enablement.
