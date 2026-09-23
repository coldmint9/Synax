# Versioned attachment visibility and lifetime verification

Date: 2026-09-23. Full goal status remains ACTIVE / INCOMPLETE.

## Implemented

- Native v3 messages and tool records can retain non-text content parts; edit/resend replaces the text part while preserving the original attachments.
- The versioned `assets` index defines current session membership. Rollback hides attachments introduced only on the popped branch, instead of consulting the union of all historical bindings.
- Migration 0064 adds `conversation_v3_asset_refs`: immutable object → external asset links, capped at ten per object by SQL and charged to the existing metadata budget. Binding records retain one asset; media-bearing message/tool records independently retain their attachments.
- Publishing an asset binding/message/tool and registering external refs are in the same transaction. No binary media content is copied into the version-object database.
- Heads/checkpoints retain media via the existing immutable DAG. Reclaiming an unreachable record removes its bounded external refs; media deletion checks both legacy bindings and v3 refs.
- Media upload deduplication considers retained v3 refs. Media sweep traverses bounded candidate identity pages rather than loading all unbound IDs.
- Binding validates actual project ownership in its write transaction; membership reads also check the current project's authority. Supplied/fabricated asset metadata cannot bypass that check.

## Important defect caught during implementation

The first binding-only design was insufficient: removing a current tool-access binding could leave a live message referencing the asset without a physical retention root. A real persistence/GC test demonstrated deletion. Direct message/tool object refs fix this; the file becomes deletable only after the last referencing version object is reclaimed.

The real Native edited-media test also exposed a fixture issue: Node structuredClone rejects URL values used by real model media parts. The fixture now explicitly clones URL objects while preserving its normal snapshot behavior. Production media validation was not weakened to make the test pass.

A pre-existing missing `valid` property annotation in file-GC query typing was also corrected; the current full API typecheck is clean.

## Verified scenarios

1. Native image-message persistence with no legacy asset-session binding rows and no binary copy into immutable payloads.
2. Current branch membership drops a popped attachment while retained checkpoint assets survive core/media GC.
3. An attachment referenced only by an older checkpoint remains protected from deletion/sweep.
4. Live message media remains protected after removing its active tool-access binding; removing the last record and collecting the DAG permits deletion.
5. Foreign-project input, forged project metadata and changed current-project authority are rejected.
6. Metadata admission failure rolls back root publication and leaves no visible binding.
7. Real Native media-only reply persists its attachment; initial edit/resend keeps a text-file attachment, replaces old text correctly and maintains retry/quota/file-restore behavior.

## Verification result

**40 test files / 318 tests PASS**, 42.38s, under a generated temporary DATA_ROOT. API `tsc --noEmit` and `git diff --check` PASS. The set includes legacy media persistence, Native edit/interaction/files/coordinator, core GC/reference invariants, DB safety, routes and probe/soak CLI tests.

No installed app or real user data was modified. No new production latency, peak RSS or physical-storage guarantee is claimed.

## Remaining objective

- Core GC was explicitly driven by lifecycle tests. Automatic production scheduling, fairness and lifetime cleanup of unreferenced objects/control rows still need integration; successful tests do not imply automatic collection is already active everywhere.
- Media upload/read paths still materialize buffers under existing 50MiB/file and 100MiB/input limits. Global binary disk/RSS/admission limits and streaming binary handling are not proven by small media fixtures.
- Child sessions/fork scope and ownership, legacy v2 migration/downgrade protection, remaining direct SQL consumers and full UI pagination/projections remain unfinished.
- File-manifest diff scaling, durable paged restore jobs, nonblocking/resumable file GC, physical DB/WAL/temp/blob quotas and worker isolation remain unfinished.
- Full cold/concurrent/end-to-end/native/API/UI/file, crash/ENOSPC and steady-state acceptance is still required before marking the original goal complete or enabling v3 by default.
