Inline visualizations (2026-09-22)

Authoring: api/skills/builtin/visualize/SKILL.md.
The visualize skill writes a self-contained HTML fragment in an authorized session
workspace and emits a standalone visualize file reference (optional title/wide mode).
Existing synax-visualize HTML fences are also supported. A single bounded HTML read
validates canonical root containment, file type, size and file stability before
freezing the fragment in message metadata. No compiler, job or artifact API returns.
Successful run replies missed by an older finalizer are hydrated once when listed;
failed/interrupted/running replies and reasoning never qualify. Missing files show
an explicit diagnostic. Once saved, source edits/deletion do not change the preview.

The transcript renders the preview at its original position between paragraphs.
Completed previews stay outside collapsed work logs, including preview-only and
step-less completion replies. Streaming source is hidden until the final metadata
arrives; user messages, nested examples and partial replies never mount previews.

Web and Electron share InlineVisualization. The wrapper has no visible toolbar,
header, border or controls; product chrome belongs to the generated fragment.
The runtime supplies neutral theme tokens, basic controls, opt-in tabs and a small
bundled Lucide set. Icons are serialized during the app build, not per reply.
The accepted demo lives only in __tests__/fixtures, not in product rendering code.

Security boundaries:
- sandbox="allow-scripts", no same-origin, navigation/download/permission grants.
- Frame CSP blocks network, workers, nested documents, eval, forms and base URLs.
- web/index.html's parent frame-src 'none' is required too: it blocks a script
  navigating its own iframe before an HTTP request. srcdoc still renders normally.
- Electron also rejects subframe navigation and exposes preload APIs only in the
  main frame. The retired native artifact manager/IPC protocol no longer exists.
- Only same-frame messages with the instance id and a cryptographic token can
  report ready/error/height; resize bounds and a message-rate limit are enforced.
- Local window.openai state aliases are in-memory only (16 KiB), never host IPC,
  persistent state or model context. Refresh/unmount resets the running instance.
- CSP/sandbox isolate capabilities, not arbitrary JS CPU consumption. This is not
  a promise of OS-level isolation from an intentionally nonterminating script.

Historical database migrations remain unchanged. Ordinary evidence artifacts and
wiki/release artifacts are separate concepts and are not removed.

Verification:
- npm test -- api/services/agent-runtime/__tests__/visualization-*.test.ts
- npm run --prefix web test -- src/react/features/visualizations src/react/features/agent-workspace/__tests__/visualizationTimeline.test.ts
- npm run build && npm run web:build && npm run test:visualize:web
  Real production API + Web conversation, disposable DB, no model/network calls.
- npm run build:electron && npm run test:visualize:desktop
  Native sandbox smoke using the real preview component and production preload;
  not full packaged-application acceptance. Optional SYNAX_ELECTRON_PATH selects an
  existing Electron runtime; SYNAX_CHROME_PATH similarly selects Chromium.

Regression for project/visualize's actual file-reference output:
SYNAX_VISUALIZATION_REFERENCE=1 npm run test:visualize:web
Uses reported-navbar.html as immutable test data; the user workspace and live DB
are not changed. Checks a step-less work_result that lacks metadata, restores via
GET /messages, then deletes the file and verifies stable reload.
