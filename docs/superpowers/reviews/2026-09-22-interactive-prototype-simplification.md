# Interactive Prototype simplification — September 22, 2026

## Implemented boundary

The approved lightweight design replaces interactive artifact publication with
completed assistant message compilation. Strict top-level `synax-prototype`
declarations reference authorized workspace HTML or default-export React/TSX;
at most three are compiled with the existing bounded, fixed-dependency worker.
Compiled HTML and safe diagnostics are attached to existing message metadata,
without replacing the message, changing sequence or resurrecting deleted/edited
messages. Reprocessed messages retain their first compiled results. Ordinary
reply text is retained; recognized declarations are hidden in the transcript.

The old publication/approval, jobs/recovery, version/fork/inheritance, persistent
state, feedback, screenshots, annotation and export services/routes/tools/UI
have been removed. Legacy 0040–0048 SQL migrations and stored data are unchanged;
old interactive cards are not rendered. The **pre-existing general evidence
artifact subsystem** (file patches, evidence summaries, read-only artifact list)
is not the interactive publication system and is deliberately retained.

Cards mount compiled message content directly, without artifact API calls. Only
an icon, status dot and preview remain. The title appears as a non-layout-shifting
hover/focus overlay, with a touch fallback. Interaction state is local and resets
on remount. Two active preview leases are retained; eviction does not cause an
auto-reacquire loop, and parked previews resume on pointer/focus or viewport entry.

Web and desktop retain nonce/instance/source identity checks (now `prototypeId`),
bounded messaging, sandbox/CSP and teardown. The SDK has only ready, theme and
resize. Native screenshot/annotation IPC is removed. A main-only pixel capture
helper remains for transport-security smoke tests, not product use.

## Verification evidence

Local logs are under `.tmp/` in this feature worktree, not committed session data.

- `prototype-final-api.log`: **264 files passed / 1 skipped; 1912 tests passed / 3 skipped**.
- `prototype-full-web.log`: **159 files passed; 926 tests passed**, plus five failures
  in four unrelated settings test files. `prototype-baseline-web.log` reproduces
  the same five failures from the unchanged HEAD snapshot with the same dependency
  runtime. Do not describe the whole Web suite as green.
- `prototype-ui-final.log`: **11 relevant Web files / 46 tests passed**, including
  real Chromium transport, hover/no-layout-shift, reset, theme, removal of controls,
  three-card lease behavior, transcript projection and existing timeline tests.
- `prototype-focused-api.log`: compiler/path/dependency/native policy suites and
  new manifest/integration tests passed (**68 tests**, native graphical test skipped).
  `prototype-persist-final.log`: **7 integration/persistence tests passed** with
  real SQLite message persistence, source deletion, preserved sequence and retired
  interactive APIs absent. The read-only generic evidence list remains available.
- API typecheck, `tsc -b web`, Electron typecheck and API/Web/Electron production
  builds passed. Logs: `prototype-*-types-final.log`, `prototype-build.log`,
  `prototype-api-build-final.log`, `prototype-web-build-final.log`.
- `prototype-web-e2e.log`: **real production Web application + actual isolated API
  passed**. Seeded a compiled message, deleted its source, opened the conversation,
  clicked the embedded prototype, then reloaded: compiled content survived and
  interaction state reset. No provider calls or production data were used.
  Evidence: `out/prototype-web-acceptance/acceptance.json` and `conversation.png`.
- Full-app QA caught a selector bug from prototype IDs containing colons. Both
  conversation-navigation selectors now escape IDs; the same real-app test passed
  after the fix. Component-only tests had not exposed that issue.

## Native environment limitation

The shared Electron dependency has no installed executable. An existing cached
39.8.10 binary was extracted into this worktree's ignored test output only; no
shared node_modules were changed. Native smoke then reached the window-focus
assertion and failed because the window could not obtain focus. A macOS lock-state
check reported a locked graphical session during this attempt. Native policy,
manager and preload unit tests pass (**22 tests**), and Electron builds, but the
full graphical native regression and packaged desktop E2E are **not verified**.
Windows/WSL, Linux and mixed-DPI acceptance are not newly claimed.

Run `npm run test:prototypes:web` after API/Web builds, and
`npm run test:prototypes:desktop` after desktop packaging in an unlocked session.
The CI workflow includes the new Web conversation test and retained native tests.
No push, release or main-worktree modification is included in this implementation.
