# Interactive artifacts: final acceptance and merge gate

Goal: finish the complete approved feature, then merge `codex/interactive-artifacts` into local `main` without modifying the other checkout's uncommitted work.

## Requirement ledger (evidence required, not intention)

| Requirement | Current implementation/evidence | Gate |
|---|---|---|
| Durable asynchronous publish, cancel/retry, UI states | `artifact-jobs.ts`, job/approval routes, `ArtifactBuildCard`, 0044/0047/0048 migrations; cancellation/commit fence and captured restart tests | Implemented; final suites pending |
| No cancelled/retried stale worker publication | transactional job status/attempt check in `commitBuild`; explicit running/queued cancellation tests | Targeted passed |
| Screenshot attachments with host confirmation | fixed capture IPC, bounded PNG multipart upload, session-bound image input parts, screenshot review | Native capture/overlay suite: 27/27 passed, including real screenshots |
| Host element outlines and transform/clip behavior | SDK clipped bounds; Web host overlay; dedicated native strips; clear on scroll/resize | Fixed native surface stacking; all four border pixels verified, clipping/zoom/hang tests passed |
| Fork immutable historical version and retain lineage | `artifact-versions.ts`, version routes, `VersionActions`, 0045 migration | Service/route/browser tests passed |
| Explicit compatible state inheritance | immutable schemas, v1–10000, source/target CAS, separate private/model confirmation | Schema/browser tests passed |
| HTML-global icons | packaged Lucide node registry, no CDN, classic HTML + dynamic icon test | Real browser + bundled CJS test passed |
| True Agent feedback loop | isolated `.tmp/artifact-live` Codex backend; synthetic HTML v1, host feedback, real source edit, same artifact v2 | Completed; v2 rendered with Demo Beta and v1 preserved |
| Refresh/restart/export/source/QA/controls | existing real browser integration plus new version Hono/SQLite/browser integration | Final rerun pending |
| All repository regressions | fixed obsolete goal/crash/loader/indicator fixtures plus real legacy-title bug; approval test isolated workspace fingerprint | Root checkpoint 1846 passed / 2 skipped; Web 847 passed / 1 skipped at maxWorkers=2 |
| Packaged deployment | API/Web/Electron builds, earlier relocated package proof; new global icon runtime CJS regression | Latest package rerun pending |
| Security review of new closing slice | separate read-only review of jobs/lineage/capture requested | Initial findings fixed; recovery ordering regression passed; closing review required |
| Platform acceptance | macOS real Electron; Windows/UNC containment unit tests | Windows/Linux/mixed-DPI/actual WSL still require matching environments; never label verified from macOS tests |
| Merge main | main advanced independently; integration with its new commits is required | Not done; waiting above gates |

## Real provider test isolation

The live test created a separate DATA_ROOT and a synthetic workspace. Only `runtime-demo.html` was read/changed after reviewing each Codex approval request. No production projects or credentials were copied into the generated artifact. The configured Codex backend/model was inherited, not replaced. Feedback persisted its original revision ID; the second ready revision references the first and leaves first source hash unchanged.

Evidence under `.tmp/artifact-live`: run/watch logs, v1 record, feedback receipt, v2 list, workspace source, isolated DB. These local files are not committed: they contain runtime credentials and native session metadata. Delivery includes only this description and safe screenshots/tests, not tokens.

## Environment changes during verification

The desktop initially could not obtain focus while macOS was locked. A later authoritative session inspection showed it unlocked; rerunning the original native test then exposed an annotation pixel mismatch. This is not recorded as an environment skip: the implementation/test must be fixed and rerun without weakening isolation or clipping invariants.

## Merge safety

`/Users/mint/workspace/Synax` is on another branch and has unrelated uncommitted work. It must not be reset, stashed, checked out, or overwritten. Merge may use this clean feature worktree or a separate main worktree once acceptance is proven. No remote push is included unless explicitly requested.

## Continuation checkpoint
The previous goal turn made concrete implementation and verification progress. The interrupted command `closing-recovery-order` finished successfully (7 tests), not left running. Main advanced to `adf56d7` in another clean worktree; merge must retain its workspace-editor, workflow and notification changes. No `master`, `test` or `beta` ref exists locally. `.DS_Store` is ignored and no tracked copy exists. No test/beta history was deliberately merged into this feature.
