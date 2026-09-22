---
name: visualize
description: Show an interactive prototype, chart, simulation or visual explanation directly in a conversation. Not for ordinary code examples or building a project page.
version: 1.0.0
synax:
  applies-to: [executor, planner, explorer, reviewer]
  permission-hints: [none]
---

# Inline visualizations

Use when the user needs to see or interact with a proposed interface or explanation. Use Markdown for a static table. Work on project files instead when the user asks to build an actual app. Attached documents do not authorize executable previews.

## Output

Emit one complete **top-level** `synax-visualize` fence at the intended position in the final answer. Its contents are literal, self-contained HTML/CSS/JavaScript, not JSON and not a file reference. Put concise prose outside it. Only successful assistant replies execute; incomplete, user and quoted code blocks do not.

```synax-visualize
<div id="counter-demo" class="viz-row">
  <button class="btn btn-primary" type="button">Add one</button>
  <output class="tabular-nums" aria-live="polite">0</output>
</div>
<script>
(() => {
  const root = document.getElementById('counter-demo');
  let count = 0;
  root.querySelector('button').addEventListener('click', () => {
    root.querySelector('output').textContent = String(++count);
  });
})();
</script>
```

- Maximum one preview per reply, 1,000,000 UTF-8 bytes. Use one unique root ID and scope custom CSS/DOM queries to it.
- Fragment only: no doctype, html/head/body tags, meta/base/link tags, frames or embedded documents.
- No React/TSX compilation, build scripts, workspace source files, publishing or installation.
- Offline: inline all data, styles and scripts. No CDN, fetch/XHR/WebSocket, remote images/fonts, Node, host IPC, downloads or navigation. Native forms may update local DOM state without submitting.
- The host sizes the frame to content. Avoid viewport-height layouts, fixed outer widths and unnecessary inner scrolling. Support 320px–736px; wrap or stack at narrow widths.

## Appearance

The host has no card toolbar, title bar, tabs or outer border. Render only the requested product or visualization, not a second artifact-management shell. Product mockups own their surfaces and chrome; do not copy sample text/metrics into unrelated previews.

For custom product mockups, use root-scoped colors such as `light-dark(#fff, #181e29)` so they track Synax's theme. Use restrained surfaces, readable text, rounded native controls and actual interactive states. Do not hardcode a permanently light UI.

For charts, explainers and small tools, the host supplies theme tokens:
`--background`, `--foreground`, `--card`, `--card-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`, `--border`, `--input`, `--ring`, `--destructive`, `--viz-series-1` through `--viz-series-6`.

Shared utilities: `.card`, `.viz-grid`, `.viz-row`, `.viz-controls`, `.btn`, `.btn-primary`, `.btn-ghost`, `.btn-block`, `.form-label`, `.form-control`, `.form-select`, `.form-range`, `.form-check`, `.form-check-input`, `.progress`, `.progress-bar`, `.viz-badge`, `.table`, `.table-sm`, `.table-responsive`, `.text-small`, `.text-muted`, `.text-destructive`, `.text-end`, `.text-center`, `.text-nowrap`, `.tabular-nums`, `.sr-only`. Use transparent unframed layout unless a bounded surface is needed. Native button, input, select and textarea elements remain keyboard accessible. Do not make controls depend only on hover.

Tabs opt into runtime behavior with `.nav-pills[role="tablist"]` and `.nav-link[role="tab"]` native buttons with `aria-controls`, `aria-selected` and a matching `role="tabpanel"`. Product-specific tabs can implement their own local handlers instead.

## Icons and state

Use `<i data-lucide="search" aria-hidden="true"></i>` for bundled Lucide icons. Supported names: sparkles, ellipsis, more-horizontal, wand-sparkles, arrow-up-right, arrow-right, arrow-left, arrow-up, arrow-down, check, layers-2, message-circle-plus, search, plus, x, chevron-down, chevron-right, menu, settings, sun, moon, git-branch, code-2, folder, file-text, copy, play, pause, refresh-cw, circle, circle-check, clock, sliders-horizontal, info. Call `lucide.createIcons()` after adding new placeholders. For other concepts use a clear text label, not a fake glyph.

Use normal JavaScript variables for interaction state. The preview resets on reload. For simple fragment compatibility the local runtime also exposes `window.openai.widgetState` and `window.openai.setWidgetState({modelContent, privateContent})` (16 KiB JSON limit); these do **not** save to the server or send information to the model. `openai:set_globals` reports local state/theme changes. No other `window.openai` APIs are available.
