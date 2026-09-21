# Interactive artifacts: final acceptance and merge gate

Updated: September 22, 2026. The release/merge checkpoint below supersedes the
September 21 baseline sections retained as historical evidence.

**Status:** merged into local `main` at the user's explicit request; the overall
software version is **0.3.0**. macOS local acceptance passed. Cross-platform
acceptance remains incomplete and is not implied by this local merge.
No remote push, release tag, publication or CI dispatch has been performed.

**User scope adjustment:** Windows environment acceptance is deferred for this
round at the user's explicit request. Actual Windows-host WSL checks are also
deferred because they require that environment. These are unverified follow-ups,
not successful tests and not current-round blockers. This adjustment does not
waive Linux or mixed-DPI checks.

## September 22 release and completed local merge

- Integrated the latest committed main `6727333` (0.2.2) into feature as `6092658`.
  Import/type conflicts were resolved by preserving both artifact functionality
  and main's conversation-history/checkpoint and update-network functionality.
- Release commit `e6f5053` sets root/Web manifests, both lockfiles, CLI, About page,
  MCP client identities and Codex/Claude client identifiers to 0.3.0. Desktop
  packaging inherits the root manifest. A two-case consistency regression test
  prevents these surfaces drifting apart unnoticed.
- Local main fast-forwarded from `6727333` to `e6f5053`. The user's explicit merge
  request superseded the prior wait-for-cross-platform merge gate; Windows/WSL
  remain deferred and Linux/mixed-DPI remain unverified, not passed.
- Only the two overlapping dirty UI test files were temporarily stashed. Both
  restored without conflicts; all other pre-existing dirty files were verified
  byte-identical immediately after merge. They remain uncommitted, not included
  in this feature or release commit. A backup patch/files are local under
  `.tmp/artifact-qa/main-030-backup`; retained safety stash:
  `b3607889dd20719030af8f3f0911e20a93adddfc`.
- Post-restore UI tests were run in the actual main checkout, along with the
  version-consistency test. No reset, forced update, remote push or `.DS_Store`
  tracking was used.

Latest evidence under `.tmp/artifact-qa` in the feature worktree:

| Verification | Result | Log |
|---|---|---|
| Full API/root regression after integrating main | 270 files passed / 1 skipped; 1987 tests passed / 3 skipped | `release-030-api.log` |
| Full Web regression after integrating main | 170 files / 976 tests passed | `release-030-web.log` |
| API/Web/Electron and CLI typechecks | Passed | `release-030-types.log`, `release-030-package.log` |
| Release consistency + desktop branding tests, full 0.3.0 build/package, general desktop smoke and artifact E2E | Passed; six artifact checks, native parser/child fork/shutdown verified | `release-030-package.log` |
| Native artifact preview | 5 files / 28 tests passed | `release-030-native.log` |
| Restored dirty UI tests on main | Three files passed | `release-030-restored-ui.log` |
| Version consistency on main | Two tests passed | `release-030-main-version.log` |

Full-suite runs preceded the final client-version literal changes; the dedicated
version tests, typechecks, production build, packaged CLI `--version` output and
macOS `CFBundleShortVersionString` were checked after those changes and report
0.3.0. Test-fixture and third-party dependency version numbers are not release
identities and were deliberately left unchanged. Skipped tests and platform gaps
remain disclosed.

## September 21 historical baseline

The sections below record the previous checkpoint. Their pending-merge statements
are superseded by the completed local merge above; their evidence remains valid
for the earlier baseline only.

## Accepted code baseline

- Feature branch: `codex/interactive-artifacts`.
- Runtime code checkpoint: `fade138` (merges main `fdb7c8d`).
- `bbc5732` adds desktop/WSL acceptance commands and aligns the lockfile with 0.2.1.
- Main's latest smoke changes were integrated without conflicts. The tests below
  ran after that merge, not only against the earlier `6b00fd7` baseline.
- Subsequent acceptance-document and CI-evidence updates do not alter runtime code.

## Requirement ledger (evidence, not intention)

| Requirement | Implementation/evidence | Gate |
|---|---|---|
| Durable async publish, cancel/retry and build cards | Job/approval routes, durable queue, recovery, UI; 0044/0047/0048 migrations | Passed in full API/Web reruns |
| No cancelled/retried/unauthorized late publication | Transactional attempt/status and current workflow checks; recovery ordering regressions | Passed; commit-fence review findings addressed |
| Screenshot attachments with host confirmation | Fixed owner/revision-bound capture IPC, stable geometry, cooldown, bounded PNG upload and image-input ownership | 28 native tests and six packaged checks passed |
| Host outlines, transform and clipping | Four script-disabled native border strips; SDK geometry; clear on scroll/resize | Four border pixels, clipping, zoom and hang isolation verified on macOS |
| Historical forks and lineage | Immutable version routes, UI and 0045 migration | Service/route/browser tests passed |
| Explicit compatible state inheritance | Schema versions 1–10000, source/target CAS, separate private/model confirmation | Service/schema/browser tests passed |
| HTML-global icons | Packaged Lucide registry, classic HTML helper; no CDN | Real browser and bundled-CJS tests passed |
| Real Agent feedback loop | Isolated Codex backend generated v1, consumed confirmed host feedback and generated v2 | Completed earlier; v1 preserved, v2 rendered |
| Refresh/restart/export/source/QA/controls | Browser integration and actual packaged production preload/sidecar/transcript | Rerun passed |
| Repository regressions | Full API and Web suites with real-browser opt-in | API 1879 passed / 2 skipped; Web 943 passed |
| Native package and general desktop compatibility | API/Web/Electron typechecks/build; Forge package; renderer/API/native-module/child-fork/shutdown smoke | Passed after isolated native-dependency preparation described below |
| Platform acceptance | macOS arm64 real Electron only | Windows/actual WSL explicitly deferred by user; Linux native and mixed-DPI still unverified |
| Feature-to-main merge | Latest committed main integrated into feature | Not done; platform gate open and main checkout has unrelated uncommitted work |

## Fresh verification evidence

Logs live under `.tmp/artifact-qa/` in this feature worktree. They are local test
outputs, not committed runtime data. Exact successful results:

| Command | Result | Log |
|---|---|---|
| `SYNAX_ARTIFACT_BROWSER_QA=1 npm test -- --maxWorkers=2` | 259 files passed / 1 skipped; 1879 tests passed / 2 skipped | `main-fdb7c8d-full-api.log` |
| `SYNAX_ARTIFACT_BROWSER_QA=1 npm run test --prefix web -- --maxWorkers=2` | 164 files / 943 tests passed | `main-fdb7c8d-full-web.log` |
| `npx tsc --noEmit`, `npx tsc -p web/tsconfig.json --noEmit`, `npm run build:desktop` | Exit 0; API, Web, Electron and macOS arm64 Forge package built | `main-fdb7c8d-build.log` |
| `SYNAX_ARTIFACT_NATIVE_SMOKE=1 npx vitest run electron/lib/artifact-preview --maxWorkers=1` | 5 files / 28 tests passed | `main-fdb7c8d-native.log` |
| `npm run test:artifacts:desktop` | Six production packaged-app checks passed | `main-fdb7c8d-packaged.log` |
| `npx electron-forge package`, `npm run test:desktop:smoke`, `npm run test:artifacts:desktop` after local dependency preparation | Exit 0; renderer, API, native modules, child fork and API shutdown passed; all six artifact checks passed again | `main-fdb7c8d-repaired-package.log` |

The two skipped API tests are disclosed, not counted as verified. Web teardown
warnings and build warnings remain visible in their logs; they did not fail the
commands. No failed native assertion was weakened to obtain these results.

The packaged artifact checks cover:
1. Actual native capture shown for host review.
2. Bounded screenshot upload through production auth and sidecar.
3. Feedback confirmation includes the image and hides the native preview behind the modal.
4. The same dedicated view expands and captures again.
5. Pause and app reload preserve the committed artifact reference.
6. Offline HTML includes the SDK and excludes runtime credentials.

Safe generated evidence: `out/artifact-acceptance/packaged-acceptance.json`,
`packaged-feedback-confirmation.png`, and `packaged-export.html`. These use only
synthetic test data. Local outputs are not a claim of remote CI success.

## Native-dependency prerequisite exposed by broader smoke

The first general desktop smoke failed because the shared `node_modules/tree-sitter`
contained neither a native build nor a platform prebuild. Compilation/Forge
packaging alone did not detect that missing dependency; artifact-only tests do
not exercise the code parser. The failure is preserved in
`main-fdb7c8d-desktop-smoke.log`.

To avoid mutating the dependency directory shared with the main checkout, the
already-copied package was compiled **only inside this worktree's `server-dist`**:

```sh
node_modules/.bin/node-gyp rebuild --directory=server-dist/node_modules/tree-sitter
npx electron-forge package
npm run test:desktop:smoke
npm run test:artifacts:desktop
```

The build output is recorded in `main-fdb7c8d-native-dependency.log`; the packaged
Electron utility process subsequently loaded the parser and parsed JavaScript.
No tracked runtime source or shared dependency directory was changed for this
repair. A clean build environment must install native dependencies with lifecycle
scripts enabled (the CI uses `npm ci --include=dev`) and pass general desktop smoke;
a successful package command by itself is insufficient evidence.

## Remaining cross-platform gate

- Host inspected: Darwin arm64. Docker Desktop was started for an isolated Linux
  acceptance attempt; no host workspace, credentials or shared node_modules are
  mounted into the build. Only `git archive fade138` was copied to its build context.
  Docker could not fetch the official `node:22-bookworm` base-image metadata:
  `registry-1.docker.io:443` timed out, independently reproduced by a bounded HTTPS
  connection probe. See `linux-build.log`. No Linux dependency installation or
  test ran; this is an environment blocker, not a test pass or an application failure.
- A stopped Windows 11 Parallels VM exists. CLI startup was rejected as requiring
  Pro/Business Edition. The ordinary graphical startup instead prompted for
  Parallels/Apple account authorization; that prompt was cancelled without login
  or account/license changes. The VM remains stopped. Windows tests were not run.
- `.github/workflows/artifact-acceptance.yml` is prepared for macOS, Windows and
  Linux browser/security/native acceptance, native packaging, full-app smoke and
  safe screenshot/report retention. Windows is opt-in via `include_windows`
  (default false), respecting this round's user deferral. YAML and local macOS commands were checked;
  **the remote workflow has not been dispatched**. It is not proof of platform success.
- `npm run test:artifacts:wsl` requires a real Windows host with an installed WSL
  distribution. It tests actual snapshot/compile/symlink containment and fails
  explicitly on an unsuitable host. CI's OS matrix alone does not verify WSL.
- Real mixed-DPI monitor transitions still need an appropriate graphical setup;
  automated zoom/clip tests are not a substitute.

Do not silently narrow acceptance beyond the explicit Windows deferral. Continue
on matching Linux/mixed-DPI environments, or obtain a separate user decision on
those release boundaries. Do not start Windows/WSL verification in this round. Pushing the feature and dispatching remote CI require authorization;
no remote publication was performed in this checkpoint.

## Real provider test isolation

The earlier live test used a separate DATA_ROOT and synthetic workspace. Only
`runtime-demo.html` was read/changed after reviewing scoped Codex approval requests.
The configured backend/model was inherited. Confirmed feedback retained its
original revision ID; v2 references v1 without changing v1's source hash.

Evidence under `.tmp/artifact-live` includes runtime credentials and native session
metadata and must **not** be committed or uploaded. Only the description and
synthetic screenshots/tests belong in the delivery. No production project data
was copied into generated artifacts.

## Merge safety and next actions

1. Obtain Linux results and mixed-DPI QA, or an explicit user-approved adjustment
   of those acceptance boundaries. Windows/actual WSL are user-deferred follow-ups
   and must not be represented as passed.
2. Recheck `main` immediately before integration; if it advances, integrate and
   rerun the affected checks rather than relying on this older checkpoint.
3. `/Users/mint/workspace/Synax` has main checked out with unrelated uncommitted
   Electron/update-settings work. Do not reset, stash, switch, overwrite or include
   that work in this feature's commits. Wait for a clean handoff before merging.
4. Once gates are satisfied and the checkout is safe, merge feature into local
   main, verify ancestry and final tests, and recheck that no `.DS_Store` is tracked.

There is no local `master`, `test` or `beta` ref. Existing history and the explicit
main integration target are retained; no branch is renamed and no test/beta
history is merged into the feature. `.DS_Store` is ignored and none is tracked.
