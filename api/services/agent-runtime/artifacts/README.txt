# Artifact storage and compiler

## Public integration

`publisher.ts` exports the requested publish/list/revisions/bundle/source/state/delete API.
Publishing resolves only after immutable source, compiled HTML, revision, head CAS and an
outbox item have committed together. Failures reject with `ArtifactError`; they do not
move the ready head. `listArtifactBuilds(sessionId, artifactId?)` exposes building/failed/
ready attempts and sanitized diagnostics separately (newest 200), without treating failed
compilations as usable revisions.

- `pendingArtifactEvents(sessionId)` returns `{id, revision}[]`.
- Deliver with a deterministic transcript/message key derived from `revisionId`, then
  `acknowledgeArtifactEvent(sessionId, id)`. Delivery may repeat after a crash.
- `recoverArtifactBuilds()` synchronously expires old leases. Failed snapshot bytes are
  retained for up to 24 hours; this maintenance drops expired bytes, not ready versions.
- `resumeArtifactBuilds()` asynchronously claims up to two expired attempts and rebuilds
  from their captured SQLite bytes, **never** from changed workspace files. Run at startup
  before outbox delivery. Repeat if more jobs remain. An incomplete captured dependency
  graph fails with an explicit republish diagnostic. The same request/key can be retried.

SQLite holds snapshot and bundle bytes, avoiding an external-blob/DB two-phase commit
and orphan-file GC. Source capture is incremental and SHA-verified on recovery. Ready
revision rows reject UPDATE. Explicit artifact/session deletion cascades owned content;
normal legacy session `INSERT OR REPLACE` is preserved with the existing SQLite default
`recursive_triggers=OFF`. Do not turn that pragma on without changing session writes.

## Supported sources

- HTML document/fragment; classic scripts share global bindings and run after the body,
  in source order and after the SDK. Module scripts are bundled independently. Local
  script/CSS dependencies and images/fonts are embedded. No workspace configuration,
  package scripts, PostCSS/Tailwind pipeline or installation is evaluated.
- React `.tsx`, `.ts`, `.jsx`, `.js`, `.mjs` entry exporting a **default component**. The
  host mounts it in `#root`. Relative modules/CSS/JSON/assets and fixed `react`,
  `react/jsx-runtime`, `react/jsx-dev-runtime`, `react-dom`, `react-dom/client`,
  `lucide-react`, and exactly `d3@7.9.0` imports are supported. D3 is also available
  to HTML module scripts (`import {select, scaleLinear} from 'd3'`); there is no CDN
  or preinstalled global `d3`. Other bare imports, including direct `d3-*` subpackages,
  are rejected. Lucide is available as React components only, not a global HTML API.
  D3 network helpers and helpers that require dynamic code generation remain subject
  to the unchanged disconnected/no-unsafe-eval policy (e.g. prefer csvParseRows over
  the dynamic object converter used by csvParse).
- Sources with symlinks, sensitive/dotfiles, encoded paths, root traversal, case/NFC
  collisions, device/FIFO inputs, or unsupported MIME types are rejected. Raster/font
  magic bytes are checked; active/external SVG is rejected. Only dependency-reachable
  files are captured. File handles use no-follow/nonblocking flags and before/after
  inode, mtime, ctime, size and hash checks; all files are reverified before commit.
- Relative references containing spaces, percent escapes, query strings or fragments
  are not resource imports. In-document `#fragment` links/CSS references are allowed.
  External anchors, forms, inline handlers, srcset, frames, refresh, object/embed and
  external resources are rejected rather than silently weakened.

## Runtime and deployment

The worker is an inline program (no separate generated worker asset). Node resolution
is anchored to the ESM compiler or bundled CJS sidecar filename. Deploy **intact**
`esbuild`, `parse5`, `react`, `react-dom`, `lucide-react`, `d3@7.9.0`, and their transitive dependencies;
allow esbuild's native executable to run outside ASAR. Do not merely inline them into
`server.cjs`. Their resolved files must share esbuild's real `node_modules` root; arbitrary
workspace node_modules, plugins and package config are not consulted. Alternate package
manager layouts that symlink outside that tree need an explicit packaging adapter.
Package metadata is located by walking upward from the real resolved entry, not by
assuming `package.json` is exported. D3's exact version is checked before compilation;
installed code is never downloaded or substituted. Versions/license notices for the
complete declared runtime dependency graph are included in source exports. Deploy that
full graph, including nested packages; copying only `d3` or `d3-*` is insufficient.
User code can name only public fixed entries; trusted package code can import only its
collected runtime graph (bounded to 200 packages). Metadata, licenses and code paths
are realpath-contained, and undeclared nested node_modules or symlink escapes are denied.
All approved package files use stable virtual `dependency:package-N/...` identities in
esbuild. Physical paths are kept only in the worker's resolver map, never passed as
bundle module identities; both comments and CommonJS wrapper keys are deployment-path
independent. The raw filesystem onLoad namespace is forbidden. HTML and ZIP preview
regressions check home/module-root leakage, and a moved-tree test proves stable output.

`artifactSdkSource()` is imported from the frontend-owned SDK and hashed into the first
head script. Hosts inject only the inert `synax-artifact-runtime` meta **before** that
script; the stored/exported bundle contains no per-instance metadata. All script/style
blocks are hash-authorized; inline HTML styles become generated classes. No unsafe-eval,
unsafe-inline, network connections, external scripts, frames, workers, or forms are
permitted by the document policy. User-generated JS is compiled, never executed by the
API worker. Preview execution/opt-in, handshake and process isolation are transport-owned.

Limits: 2 MiB textual source, 20 MiB binary assets, 100 captured files, 10 MiB compiled
HTML, 15 seconds per compile, two concurrent compiler workers, 16 KiB JSON state,
500 MiB session and 2 GiB total accounted storage. HTML has a 10,000-markup/node cap,
128-level depth cap, and 128 attributes per element; SVG has a 2,000-markup cap.
Worker JS heap is capped at 256 MiB. **The native esbuild child is not hard memory-capped
by worker_threads**; do not advertise an OS-wide build memory guarantee. Main-thread
bounded snapshot I/O and final DB commit are not interruptible. Compiler accepts an
AbortSignal; publisher also honors an optional context.signal supplied by the host,
checking it before capture, during dependency capture and before committing ready.

## Export and explicit boundaries

`export.ts` returns offline HTML or a deterministic ZIP STORE archive containing original
source, manifest, dependency/license notices, and precompiled `preview.html`. No npm
install or shell/build scripts are added. Host state/session IDs/tokens/absolute paths
are not injected into exports; user-authored source is retained as authored. SDK local
fallback provides offline state and rejects host-only feedback explicitly.

The existing workspace resolver may supply an authorized Windows UNC WSL root. On
Windows this uses native filesystem access; root containment handles drive roots, case
aliases and UNC shares while source filenames remain relative and traversal-checked.
No custom WSL shell/remote reader is added, and a raw Linux path must not be reinterpreted
as a host path on another platform. Windows/UNC path rules are unit-tested; actual WSL
filesystem execution has not been exercised on the macOS development host. This layer does not make
the browser an OS sandbox: self-navigation/renderer CPU and standalone-file behavior
need the Web/Electron transport's documented limits. No hard OS memory guarantee,
workspace build plugins, arbitrary packages, schema-based cross-revision state migration,
or ready-version garbage collection is claimed.

Tests cover source validation, fixed dependency builds, HTML/CSS/SVG negative policy,
timeout/abort, quotas, CAS, immutable retry, failed status, migration lifecycle,
transaction rollback, crash recovery, export ZIP integrity, and real Chrome offline SDK
and React/D3 chart interaction. Package tests reject entry/manifest/license escapes and
undeclared dependencies. Browser tests run when Chrome/Chromium is installed (or
`SYNAX_ARTIFACT_BROWSER` points to it); they never substitute a simulated DOM.
