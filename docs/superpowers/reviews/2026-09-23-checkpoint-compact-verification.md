# Compact checkpoint storage and bounded GC verification

Date label uses Asia/Shanghai local time (2026-09-23); raw samples use UTC.

## Status and boundaries

Compact storage, durable pins, bounded DAG collection and metadata admission are implemented. **The full goal remains incomplete: runtime session reads/writes, history endpoints, renderer pagination, worker scheduling, file compensation and v2 migration are not integrated.** Current installed Synax and its user database were not modified.

## Reproduction

```sh
node --max-old-space-size=128 --import tsx scripts/checkpoint-version-benchmark.ts --entries 10000,100000,1000000 --switches 1000 --output /tmp/compact-no-gc.json
node --max-old-space-size=128 --import tsx scripts/checkpoint-version-benchmark.ts --entries 10000,100000,1000000 --switches 1000 --collect 1 --checkpoints 1000 --output /tmp/compact-gc.json
node --max-old-space-size=128 --import tsx scripts/checkpoint-version-soak.ts --operations 10000 --output /tmp/compact-soak.json
```

Output files must not already exist. Each program owns a new temporary disk-backed DB and deletes only that fixture. WAL + synchronous=FULL + 8MiB SQLite cache; Apple M4 / Node v22.23.2. Host CPU was not exclusively reserved. Measurements are warm native-core probes, not UI/API latency or complete process-tree memory acceptance.

## Storage comparison

Unique content is 256 bytes per indexed entry. Main DB size excludes separately reported WAL/SHM. The no-GC comparison isolates representation changes; the GC case also retains 1,000 checkpoint pins and a reader pin for the mid-history version. For small cases several pins legitimately refer to the same published batch version.

| Entries | Original DB MiB | Compact, no GC MiB | Compact + GC + 1k pins MiB | GC WAL MiB |
| ---: | ---: | ---: | ---: | ---: |
| 10,000 | 9.44 | 4.80 | 4.99 | 5.74 |
| 100,000 | 96.35 | 45.13 | 45.32 | 5.89 |
| 1,000,000 | 1054.57 | 466.67 | 428.48 | 7.49 |

At 1M entries, main DB footprint is reduced by **59.37%** versus the initial prototype, without removing retained checkpoints. Raw content is 244.14MiB, so 428.48MiB is still storage amplification, not zero-cost history.

Changes responsible: binary identities, compact per-object adjacency, reference positions inside tree nodes, removal of edge/reverse-edge tables, and collection of unpinned intermediate roots. Root switches/forks still leave immutable object counts/bytes unchanged.

## Core latency and memory with GC / 1k retained pins

| Entries | Switch p99 ms | First index page p99 ms | Fork p99 ms | Sampled peak RSS MiB | Build + generation maintenance s |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 0.366 | 0.237 | 0.223 | 85.98 | 0.37 |
| 100,000 | 0.224 | 0.261 | 0.191 | 131.38 | 6.65 |
| 1,000,000 | 0.873 | 1.022 | 1.101 | 180.84 | 159.78 |

- 128MiB V8 old-space runs completed without OOM. This is not a 128MiB RSS limit; native/external memory is separately reported.
- First index pages contain references, not fully rendered message content. Cold starts and normal application execution-context/IPC overhead are not covered.
- GC deadline is cooperative. Worst measured whole GC call (including commit) was about 99.33ms in the million-entry run and 62.19ms in the soak, despite a 10ms loop deadline. Native SQL/commit cannot be preempted by that JS deadline. Worker isolation and foreground scheduling remain required, not optional.
- A separate isolated probe observed six WAL frames for pinning either a 256-byte or 64KiB object, so no evidence justified a speculative ref-count-table rewrite to avoid full large-blob WAL copies.

## 10,000-operation soak

Each operation writes unique 1KiB content; every fifth operation rolls back. The workload retains three checkpoints, a fork and a transient reader crossing root switches, and checks their contents against independent bounded maps. GC runs in bounded rounds.

- 10,000 operations / 2,000 rollbacks in 27.93s.
- 29,981 objects reclaimed; no pending eligible garbage after final drain.
- Peak immutable objects: 31; peak charged immutable bytes: 27,575.
- Final immutable objects: 20; bytes: 15,463.
- Sampled peak RSS: 154.56MiB; sampled peak heap: 32.51MiB.
- Final main DB: 380.00KiB; WAL: 3.99MiB.
- Idempotency/control metadata uses 676,428 logically reserved bytes under a 64MiB hard reservation ceiling. It intentionally grows with retained operation results; do not describe all metadata as constant-size.
- Immutable content reaches a small steady working set; exact raw samples are archived rather than inferred from a final object count alone.

## Failure / correctness validation

Final isolated run: **18 test files, 111 tests PASS**, covering core stores, pins/GC, benchmark/soak programs, DB migrations/compatibility, execution fencing and the existing conversation/file recovery/route suites. API and standalone benchmark/soak TypeScript checks PASS.

Additional faults found and fixed:
1. A sole Buffer binding can make the installed libSQL binding abort; named binary parameter maps avoid that path. `.all()` BLOB representation differs from `.get()`; collector IDs are bounded hex strings at the JS boundary.
2. Real SQLite page-limit exhaustion auto-aborts an outer transaction. Error handling now preserves SQLITE_FULL and fences the connection, instead of masking it with a second rollback error or allowing later writes to auto-commit.
3. Failed savepoint rollback poisons both version and application compatibility writes; an outer callback cannot swallow the error and commit partial state. Reopening the connection is required.
4. Fully escaped maximum-size keys could create unary tree levels until the depth limit. Packing now permits a pair within the hard node limit; regression test confirms bounded progress.
5. Metadata-limit failures roll back head/epoch/pins/idempotency results. Immutable charged identities prevent quota drift; forgotten foreign-key enablement cannot create a pin to a missing object.
6. Bounded proof cleanup avoids FK cascade fanout. Pin retention, sharing, reopen continuation, corruption rejection and exact reference-count accounting are verified.

## Not yet achieved / next critical path

1. Connect the version store to real native session mutations and all historical readers. Use a version-aware record repository with bounded large-value handling, immutable indexes and explicit fork/session scope; do not reconstruct all old live rows during rollback.
2. Replace the actual checkpoint/apply/fork routes and renderer refresh path only after context/search/export/control consumers are migrated and root/epoch semantics match existing behavior.
3. Add worker ownership, foreground priority, bounded input/IPC queues, read pins across long jobs and verified dead-owner recovery. Persistent pins are deliberately not expired by guessed TTL/PID.
4. Preserve/port file conflict and Git boundaries, durable compensation, and old v2 checkpoint conversion in bounded batches.
5. Enforce physical disk/WAL/temp/external-CAS admission; current metadata and object quotas are logical, and disk snapshots are observations. Filesystem shrinking, metadata retention policy and cross-platform behavior remain open verification work.
6. Run end-to-end cold/warm/concurrent/API/UI and real file/ENOSPC/crash tests. Core probes and SQLite page-limit failure injection do not prove these requirements.
