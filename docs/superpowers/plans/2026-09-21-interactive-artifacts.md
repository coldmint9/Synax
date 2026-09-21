# Interactive Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Track each task below; never downgrade security silently.

**Goal:** Complete publish → inline interactive preview → QA → feedback → new revision → restore/export.
**Architecture:** Immutable session-scoped snapshots, guarded compiler/publisher, dedicated preview SDK, React transcript artifact cards, isolated desktop transport. Structured publication metadata drives rendering, not raw HTML in Markdown.
**Tech Stack:** TypeScript, SQLite/libsql, Hono, parse5, esbuild, React, Electron WebContentsView, Vitest.
**Spec:** `docs/superpowers/specs/2026-09-21-interactive-artifacts-design.md`

## Global Constraints
- Source 2 MiB; local assets 20 MiB; 100 files; compiled bundle 10 MiB; build 15 seconds; state 16 KiB; message 32 KiB; 12 controls.
- No workspace scripts/npm install/CDN execution. Node APIs unavailable to generated content.
- Immutable revision + compare-and-swap, session authorization, feedback user confirmation.
- Web execution opt-in; do not claim browser CSP enforces all network navigation isolation.
- Reuse the supplied isolated worktree; no changes to the original checkout.

## Tasks and independent write scopes

### 1. Contracts, storage, compiler, publisher
Files: `api/services/agent-runtime/artifacts/{contracts,validation,store,snapshot,compiler,publisher,export}.ts`, artifact migration, tests.
Consumes `ArtifactPublishContext` and `ArtifactPublishInput`; produces `publishArtifact(context,input): Promise<ArtifactRevision>`, `listArtifacts(sessionId)`, `listRevisions(sessionId,artifactId)`, `getArtifactBundle(sessionId,revisionId)`, `getArtifactSource(sessionId,revisionId)`, `getArtifactState(sessionId,revisionId)`, `saveArtifactState(sessionId,revisionId,state,expectedEtag)`, `deleteArtifact(sessionId,artifactId)`.
- [ ] Write tests: `expect(()=>readSnapshot(root,'../secret')).toThrow()`, duplicate publication returns same revision, stale base rejects, cross-session reads reject, unsafe HTML rejects.
- [ ] Run red: `npx vitest run api/services/agent-runtime/artifacts/__tests__`.
- [ ] Implement safe snapshot reader, immutable DB transactions, sandbox compiler, quotas and export. HTML runtime obtains `artifactSdkSource()` from task 2 before source scripts. `getArtifactSource` returns `ArtifactFile[]`.
- [ ] Run green plus API typecheck; inspect migrations against existing runtime tables.

### 2. SDK and frontend
Files: `api/services/agent-runtime/artifacts/runtime-sdk.ts`; `web/src/react/features/artifacts/*`; `web/src/lib/api/artifacts.ts`.
Consumes types in contracts, API routes below, and `ArtifactCard({sessionId,reference})` used by task 4. SDK source function returns plain JS, no Node imports in generated code.
- [ ] Write bridge tests rejecting wrong nonce/source/oversized state, controls validation, privateState exclusion from feedback.
- [ ] Implement handshake/MessageChannel, 16KiB state limit, theme/height, declarative controls, feedback drafts, element picking, standalone fallback.
- [ ] Implement card opt-in preview, pause/reload/expand/source/version diff, host QA confirmation, persistence, explicit export actions. Desktop `window.electronAPI.artifactPreview` is task 3's transport; do not silently use iframe on desktop transport failure.
- [ ] Test accessible controls and all pending/error states with Vitest; verify prototype visually in browser.

### 3. Isolated Electron preview
Files: `electron/lib/artifact-preview/*`, `electron/artifact-preload.ts`, `electron/{main,preload}.ts`, associated types.
Interface renderer: `artifactPreview.create({id,html,revisionId,nonce,bounds})`, `update({id,bounds,visible})`, `send({id,message})`, `destroy(id)`, `onMessage(listener)`; methods async. bounds are window-content CSS coordinates, message envelope carries id.
- [ ] Write tests for URL policy, bounded geometry and schema; blocked http/file, arbitrary sender and stale instance.
- [ ] Implement per-view ephemeral session, only private artifact protocol allowed, permission/navigation/download denial, minimal preload forwarding fixed envelopes, owner lifecycle cleanup and stop.
- [ ] Host overlays and viewport clipping must hide/crop views; never overlay host confirmation UI.
- [ ] Run Electron typecheck/tests; native QA on actual Electron, not just jsdom.

### 4. Agent/API/transcript/feedback integration (main worker)
Files: `api/routes/agent-artifacts.ts`, tools and tool-registry, external backend completion hook, API startup, transcript blocks/projection, existing send queue.
Routes under `/sessions/:sessionId/artifacts`: POST publish; GET list; GET `/:artifactId/revisions`; GET `/revisions/:revisionId/{bundle,source,state,export}`; PUT state with expectedEtag; POST `.../feedback`; DELETE `/:artifactId`.
- [ ] Test publish/read/state/feedback authorization and errors; feedback draft cannot send until host confirms.
- [ ] Bind publish context from session; only completed assistant manifest parsed, never user/tool text; idempotency key derived from persisted message ID/block.
- [ ] Persist artifact-ready metadata/event and render a dedicated block, deduped on reload/SSE. API transport uses JSON, not navigable same-origin HTML.
- [ ] Feedback returns a persisted draft identifier + canonical text; host confirmation enqueues through existing composer/action route with idempotency guard.
- [ ] Agent instructions and sample runtime card demonstrate SDK and HTML/React publication.

### 5. End-to-end, review and delivery
- [ ] Tests: publish HTML and React, parameter controls, state restore, feedback, v2, v1 unchanged, export; pending/crash/delete/permission boundaries.
- [ ] Run API tests, Web tests/typecheck/build, Electron tests/build, packaging path review.
- [ ] Review whole change for arbitrary file/IPC/network access, stale ports and repeated messages.
- [ ] Record actual verification and limitations, no untested completion claims.

## Execution ledger
- Plan prepared. Ruling: execute in this existing worktree with disjoint workers authorized by the execution skill; main owns integration and contracts, not workers' implementation scopes.
- Baseline: clean worktree based on design commit; node_modules linked read-only in practice from original checkout for existing dependencies. Package changes, if necessary, must be made only here.

## Verification and scope ledger
- Core tasks 1–4 implemented and tested. Task 5 checkpoints: 161 API/compiler/Electron tests and 66 Web tests passed; real app conversation and relocated package exercised.
- Ruling: SQLite stores immutable bytes atomically instead of separate disk blobs — simpler crash integrity; storage quotas remain enforced.
- Ruling: external ask-policy publication uses a dedicated persisted host approval card, not the already-finished external tool loop — deny/allow semantics remain intact.
- Full design is not marked 100% complete: remaining screenshot/lineage/state inheritance/job-management UX and platform QA are enumerated in `docs/superpowers/reviews/2026-09-21-interactive-artifacts-verification.md`.
- No claim that all repository tests pass: baseline thinking-dot test fails identically before the change.
