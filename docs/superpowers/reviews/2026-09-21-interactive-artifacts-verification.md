# Interactive artifacts implementation and verification

## Implemented

- Immutable session-scoped HTML/React/D3 snapshots, local dependency capture, bounded isolated compilation, CSP, packaged dependencies, offline HTML/ZIP export.
- Native publish/read/list tools and successful completed-message manifest adapters for external/ACP backends.
- External publication respects deny/ask/allow. Ask creates a persisted host approval card; pending→publishing is claimed atomically and rejection cannot race an approved build.
- Structured transcript artifacts remain visible outside folded work logs, including artifacts without a run/step; old messages pin old revisions.
- Interactive Web opt-in and dedicated isolated Electron transport. Host SDK provides theme, height, state, parameter controls, element identification and reviewed feedback.
- Host QA, source/version comparison, pause/reload/fullscreen without remount, state CAS, LRU maximum two active previews, offscreen/background suspension.
- Confirmed feedback is transactionally enqueued once. Prototype-generated drafts cannot send on their own. Feedback excludes private state.
- Crash recovery runs periodically so future leases and batches are revisited. Interrupted builds are retryable; genuine compilation deadlines are terminal; compiler contention defers rather than loses recovered jobs.
- Runtime permission/network/window/IPC isolation tested in real macOS Electron; Web limitations are disclosed, not represented as equivalent OS isolation.

## Design adjustments and remaining scope

The implementation is usable end-to-end, but is not a literal implementation of every item in the architectural design:

1. Source and bundle snapshots are transactionally held in SQLite instead of a separate blob filesystem. This removes orphan-blob/two-phase-commit failure modes; quotas include these bytes.
2. Publish HTTP calls currently wait for bounded compilation and return a committed revision. Durable build records and read-only `/builds` diagnostics exist, but there is no full asynchronous job-management UI/API with individual cancellation. Native tool cancellation is supported.
3. Screenshot attachments are not exposed in the QA UI. Desktop has a main-only true capture method and verification screenshots; feedback currently contains text, controls, model-visible state and textual element anchors, not host-drawn bounding-box annotations or image attachments.
4. New revisions start with isolated state. Explicit schema-compatible state inheritance and a lineage/fork UI are not implemented. A separate artifact can be published without reusing an artifactId; history is never overwritten.
5. React Lucide and fixed D3 are supported. A classic-HTML global Lucide helper is not supplied.
6. Native Windows/Linux, mixed-DPI transitions and actual WSL filesystem execution could not be verified on this macOS host. Drive/UNC containment has unit coverage; no arbitrary WSL shell reader was added.
7. No credentials/live model were used in isolated QA. The agent-facing tool/manifest and feedback-to-publication loop have automated integration coverage, not a billed live-provider run.

## Verification evidence

- `.tmp/artifact-qa/acceptance-backend.log`: 163 tests passed / 27 files at the final acceptance checkpoint, including opt-in real Electron transport and real browser compiler tests. Includes approval-race and recovery-contention regressions.
- `.tmp/artifact-qa/acceptance-frontend.log`: 66 tests passed / 14 files, with opt-in real Chromium SDK/host/card tests.
- API/Web/Electron typechecks and production builds passed at their recorded checkpoints; final reruns are recorded in the final logs.
- `.tmp/artifact-qa/package-check.log`: relocated sidecar outside repository node_modules ancestry published both HTML and React/D3, with no host path in compiled output.
- Real Synax route with isolated test data was opened: published card, execution consent, Mini/Detail interaction, QA parameter changes, persisted state after reload, v1/v2 history and source comparison observed.
- `.tmp/artifact-qa/live-preview.png`: actual Synax conversation screenshot, not a hand-written preview substitute.
- Native smoke additionally exercises clipping, 2× zoom, separate sessions, network/STUN denial and termination of a hanging preview while sibling/host remain alive.

## Existing unrelated failure

The broader Web regression run includes `TurnBody.test.tsx`'s expectation of three thinking dots after completed tools, while the component renders none. The identical failure was reproduced using the original `72db45b` TurnBody implementation, in `.tmp/artifact-qa/baseline-turnbody.log`. It was not changed to mask the failure. Do not describe the entire repository test suite as green.

## Security review closure work

Initial review found feedback FK/REPLACE dedup loss, ungated external publication, missing packaged parse5/entities, nested Markdown example publication, compiler-generated host paths and startup-only lease recovery. All received fixes and targeted checks. Follow-up review identified approval/rejection race, recovery contention terminalization and infinite timeout recovery; separate claim states, retryable capacity deferral and interrupted-vs-timeout classifications now cover them.

No merge, push, remote publication, credentials modification, or change to the original source checkout is part of this delivery. Work is on `codex/interactive-artifacts` in the supplied isolated worktree.

## Full-suite result (not hidden by targeted acceptance)
The complete root `npm test` run recorded 1778 passing, 5 failing, 2 skipped tests (252 files). One failure was caused by the new builtin skill being offered to explorer sessions; the skill now declares `synax.applies-to: [executor, synax]`, and that capabilities test passes on rerun. Four test files still fail on focused recheck: corpus-loader timeouts, goal-control wording, runtime-crash status expectation and legacy session-title summarization. These files were not modified by this implementation; they are unresolved failures, not claimed as a green suite. The broader Web run also retains the independently baseline-reproduced TurnBody thinking-dot failure.

Final review closed all reported P1/P2 security/correctness findings. Scope exclusions above remain explicit; there is no assertion that the complete architectural design or every platform acceptance case is finished.
