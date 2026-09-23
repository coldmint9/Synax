# Versioned attachment visibility and lifetime plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans, real persistence tests before implementation.

**Goal:** Remove the attachment rollout guard safely for Native v3 messages/tools/edit, while retaining referenced files across checkpoints and allowing unreachable branch assets to be collected.

**Architecture:** The immutable `assets` table in each session version defines current membership. Asset-binding records and media-bearing message/tool records have external-asset references keyed by their immutable object hashes. Retained roots/checkpoints pin those objects through the existing DAG. Reclaiming an object removes at most ten reference rows; physical asset deletion remains a separate policy that checks both legacy bindings and v3 references. No binary media is copied into version objects.

## Constraints

- Validate project ownership, MIME/content-part type and existing file integrity/size policies before publication.
- Reference registration and head/message publication are one SQLite transaction.
- Binding objects have one external-asset ref; media-bearing records have at most ten, enforced by SQL. Their GC cascades are bounded. Ref metadata is charged to the existing metadata quota.
- Current membership is not inferred from the union of retained checkpoints. A popped attachment is inaccessible through the current session but may remain protected by a retained checkpoint until release.
- No automatic v3 migration/default enablement. Physical media reading/upload caps and global resource admission remain separate unfinished gates.

## Tasks

- [x] RED tests for Native message binding, branch-scoped membership, checkpoint retention through core/media GC, foreign-project rejection, and deletion after the last version reference is reclaimed.
- [x] Add 0064 external-asset ref registry and bounded quota triggers; keep the legacy binding table guarded for versioned sessions.
- [x] Publish asset bindings through the version repository and register the final immutable binding object atomically; deduplicate already-bound assets.
- [x] Update media dedup/delete/sweep policies to consider v3 refs and paginate sweep identities.
- [x] Remove Native message/edit guards only after the lifetime tests pass; preserve non-text parts on edit and verify a real media-only Native reply.
- [x] Run legacy media, Native edit/file/interaction, core GC and DB safety suites, and typechecks; record remaining cross-platform/memory/migration/UI/fork work honestly.

## Evidence

- A test exposed that binding-only retention could delete media still present in a live message. Direct message/tool object references were added; removing tool-access bindings no longer deletes live transcript media.
- Project checks are revalidated inside publication transactions and on current-session access. The implementation rejects forged project metadata and current-project changes, rather than trusting a prior validation result.
- Final isolated run: 40 files / 318 tests PASS (42.38s); API typecheck PASS. Real Native media-only completion and edited input retaining its attachment pass. The test request-cloning helper was fixed to preserve URL objects instead of failing inside Node structuredClone.
- Runtime-media binaries remain external and subject to the existing per-file/request limits. Whole-system media disk/RSS budgets, production version-GC scheduling, migration, UI and fork/child ownership remain unfinished.
