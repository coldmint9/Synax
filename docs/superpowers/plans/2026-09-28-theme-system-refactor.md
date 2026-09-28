# Theme System Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current accent-only appearance plumbing with a versioned, importable theme system whose semantic tokens drive Web, Electron, settings, layout, and terminal UI consistently.

**Architecture:** Add a focused `web/src/lib/theme/` domain containing the theme contract, defaults, normalization, runtime projection, persistence, and Zustand store. Keep shell preferences focused on non-theme settings, expose stable `--theme-*` CSS variables plus compatibility aliases, and migrate existing consumers incrementally. The settings page owns presentation and delegates import/export/mutation to the theme store.

**Tech Stack:** TypeScript, React 19, Zustand 5, Zod 4, CSS custom properties, Vitest, Testing Library, Vite, Electron renderer integration.

**Spec:** `docs/superpowers/specs/2026-09-28-theme-system-refactor-design.md`

## Global Constraints

- Do not add `.DS_Store` files to git.
- `main` is the production branch; this work stays on `codex/theme-system-refactor` and must not merge `test` or `beta` into it.
- `.env.version` remains the only version source; do not manually change package versions.
- Keep existing unrelated working-tree changes intact and never stage them in theme commits.
- The imported theme format is JSON, versioned with `version: 1`, and accepts partial light/dark token overrides.
- Invalid or unsupported theme imports must leave the current active theme unchanged.
- Theme components consume semantic tokens and must not hard-code theme-specific HEX values.

## File Map

### New files

- `web/src/lib/theme/contract.ts` — public theme types, token keys, version constants, import result types.
- `web/src/lib/theme/defaults.ts` — built-in Synax light/dark theme and default shape/effect tokens.
- `web/src/lib/theme/schema.ts` — Zod schema for untrusted JSON input and field limits.
- `web/src/lib/theme/normalize.ts` — color normalization, partial merge, migration helpers, stable export formatting.
- `web/src/lib/theme/runtime.ts` — resolved theme selection and CSS custom-property projection.
- `web/src/lib/theme/io.ts` — browser file import and JSON download export helpers.
- `web/src/react/state/themeStore.ts` — theme state, persistence, system mode, import/export actions.
- `web/src/lib/theme/__tests__/normalize.test.ts` — contract and normalization tests.
- `web/src/lib/theme/__tests__/runtime.test.ts` — runtime and CSS variable projection tests.
- `web/src/react/state/__tests__/themeStore.test.ts` — store migration/persistence tests.

### Modified files

- `web/src/lib/appearance.ts` — keep legacy pure helpers only where required, re-export or delegate theme-compatible helpers during migration.
- `web/src/react/state/shellStore.ts` — remove theme state/actions/persistence from the shell domain and preserve non-theme preferences.
- `web/src/main.tsx` — hydrate/start the theme runtime through the new store.
- `web/src/react/design/tokens.css` — define `--theme-*` variables and map existing aliases to them.
- `web/src/index.css` — replace theme-specific hard-coded values touched by the migration with semantic variables.
- `web/src/react/features/settings/components/AppearanceSection.tsx` — consume `useThemeStore`, add import/export/reset controls, preserve current UI copy and preview.
- `web/src/react/features/settings/components/appearance.css` — style the new theme metadata and file actions using semantic variables.
- `web/src/react/components/ThemeToggle.tsx` — read/write the theme store.
- `web/src/react/layouts/ActivityBar.tsx` — read resolved theme and toggle through the theme store.
- `web/src/react/layouts/ProjectLayout.tsx` — read resolved theme and toggle through the theme store.
- `web/src/lib/electron-menu.ts` — route menu theme toggles through the theme store.
- `web/src/react/features/terminal/TerminalViewport.tsx` — derive xterm theme from normalized semantic tokens.
- `web/src/react/features/settings/components/__tests__/AppearanceSection.test.tsx` — cover theme store actions and import/export UI.
- `web/src/react/components/__tests__/ThemeToggle.test.tsx` — update store boundary tests.
- `web/src/react/features/terminal/TerminalViewport.test.tsx` or the existing terminal test location — cover xterm theme derivation if a test seam exists.

## Task 1: Build the theme contract and default token set

**Files:**
- Create: `web/src/lib/theme/contract.ts`
- Create: `web/src/lib/theme/defaults.ts`
- Create: `web/src/lib/theme/schema.ts`
- Create: `web/src/lib/theme/normalize.ts`
- Test: `web/src/lib/theme/__tests__/normalize.test.ts`

**Interfaces:**
- Produces `SynaxTheme`, `NormalizedTheme`, `ThemeColorTokens`, `ThemeShapeTokens`, `ThemeEffectTokens`, `ThemeMode`, `ResolvedTheme`, `normalizeTheme(input)`, `mergeTheme(base, override)`, and `themeToExport(theme)` for later tasks.

- [ ] **Step 1: Write failing normalization tests**

Add tests covering:

```ts
it("fills omitted light and dark tokens from the Synax defaults", () => {
  const theme = normalizeTheme({
    version: 1,
    id: "mist-blue",
    name: "Mist Blue",
    colors: { light: { accent: "#98AEC B".replace(" ", "") } },
  });
  expect(theme.colors.light.accent).toBe("#98aecb");
  expect(theme.colors.dark.canvas).toBe(DEFAULT_THEME.colors.dark.canvas);
});

it("rejects unsupported versions and invalid color values", () => {
  expect(() => normalizeTheme({ version: 2, id: "x", name: "x" })).toThrow(
    /version/i,
  );
  expect(() => normalizeTheme({
    version: 1,
    id: "x",
    name: "x",
    colors: { light: { accent: "javascript:alert(1)" } },
  })).toThrow(/accent|color/i);
});

it("round-trips only portable theme fields", () => {
  const normalized = normalizeTheme({ version: 1, id: "x", name: "X" });
  expect(themeToExport(normalized)).toEqual(expect.objectContaining({
    version: 1,
    id: "x",
    name: "X",
  }));
  expect(JSON.stringify(themeToExport(normalized))).not.toContain("resolved");
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm exec vitest run web/src/lib/theme/__tests__/normalize.test.ts`

Expected: FAIL because the theme domain files and functions do not exist.

- [ ] **Step 3: Implement the contract and schema**

Define the exact v1 types from the spec. Use Zod to validate JSON input, require `version: 1`, non-empty bounded `id`/`name`, and allow only the declared token keys. Use a recursive `Record` only for the two declared mode maps; do not accept executable values or arbitrary nested objects.

- [ ] **Step 4: Implement defaults and merge/normalize**

Create `DEFAULT_THEME` with the current light/dark values from `appearance.ts` and `tokens.css`. Normalize 3/6-digit HEX to lowercase 6-digit HEX, preserve valid CSS shadow strings, and merge partial overrides onto the default theme. Keep `accent` plus derived `accentForeground` and `accentSoft` deterministic so imported themes and legacy accent edits share one path.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm exec vitest run web/src/lib/theme/__tests__/normalize.test.ts`

Expected: PASS.

Commit only Task 1 files:

```bash
git add web/src/lib/theme && git commit -m "feat: add versioned theme contract"
```

## Task 2: Add theme runtime and CSS variable projection

**Files:**
- Create: `web/src/lib/theme/runtime.ts`
- Create: `web/src/lib/theme/__tests__/runtime.test.ts`
- Modify: `web/src/react/design/tokens.css`
- Modify: `web/src/index.css`

**Interfaces:**
- Consumes `NormalizedTheme` and `ResolvedTheme` from Task 1.
- Produces `resolveThemeTokens(theme, resolvedTheme)`, `applyThemeRuntime(theme, resolvedTheme)`, and `readThemeCssVariables()` for JS consumers/tests.

- [ ] **Step 1: Write failing runtime tests**

Cover:

```ts
it("projects resolved light tokens to stable semantic CSS variables", () => {
  applyThemeRuntime(DEFAULT_THEME, "light");
  expect(document.documentElement.style.getPropertyValue("--theme-canvas")).toBe(
    DEFAULT_THEME.colors.light.canvas,
  );
  expect(document.documentElement.classList.contains("dark")).toBe(false);
});

it("projects dark tokens and keeps compatibility aliases in sync", () => {
  applyThemeRuntime(DEFAULT_THEME, "dark");
  expect(document.documentElement.style.getPropertyValue("--theme-surface")).toBe(
    DEFAULT_THEME.colors.dark.surface,
  );
  expect(document.documentElement.style.getPropertyValue("--background")).toBe(
    DEFAULT_THEME.colors.dark.canvas,
  );
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm exec vitest run web/src/lib/theme/__tests__/runtime.test.ts`

Expected: FAIL because `runtime.ts` and `--theme-*` projection are not implemented.

- [ ] **Step 3: Implement runtime projection**

Set `document.documentElement.classList` and `colorScheme`, write every `--theme-*` variable, and write compatibility variables (`--background`, `--foreground`, `--border`, `--surface`, `--primary`, `--primary-foreground`, status aliases, and the existing `--ui-*` aliases). Keep DOM writes in one function so tests and consumers have one source of truth.

- [ ] **Step 4: Migrate token CSS aliases**

Update `tokens.css` so all default values are expressed through `--theme-*` variables and light/dark selectors no longer duplicate independent theme truth. Preserve existing public aliases used by Tailwind and legacy components. Replace only directly related hard-coded theme values in `index.css` with semantic variables; do not rewrite unrelated layout styles.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm exec vitest run web/src/lib/theme/__tests__/runtime.test.ts web/src/react/design/tokens.test.ts`

Expected: PASS.

Commit only Task 2 files:

```bash
git add web/src/lib/theme/runtime.ts web/src/lib/theme/__tests__/runtime.test.ts web/src/react/design/tokens.css web/src/index.css && git commit -m "feat: project themes through semantic tokens"
```

## Task 3: Extract theme state, persistence, and legacy migration

**Files:**
- Create: `web/src/react/state/themeStore.ts`
- Create: `web/src/react/state/__tests__/themeStore.test.ts`
- Create: `web/src/lib/theme/io.ts`
- Modify: `web/src/react/state/shellStore.ts`
- Modify: `web/src/main.tsx`

**Interfaces:**
- Consumes Task 1 normalization and Task 2 runtime.
- Produces `useThemeStore`, `hydrateThemePreferences()`, `startThemeRuntime()`, `importThemeFile(file)`, `exportActiveTheme()`, and `ThemeState`.

- [ ] **Step 1: Write failing store tests**

Add tests for:

```ts
it("migrates the old shell appearance preferences once", () => {
  localStorage.setItem("rumbling-shell-preferences", JSON.stringify({
    theme: "dark",
    accentColor: "#98aecb",
    locale: "zh",
  }));
  hydrateThemePreferences();
  expect(useThemeStore.getState().mode).toBe("dark");
  expect(useThemeStore.getState().activeTheme.colors.dark.accent).toBe("#98aecb");
});

it("does not replace the active theme when import validation fails", async () => {
  const before = useThemeStore.getState().activeTheme;
  await expect(importThemeFile(new File(["{bad"], "bad.json"))).resolves.toMatchObject({ ok: false });
  expect(useThemeStore.getState().activeTheme).toEqual(before);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm exec vitest run web/src/react/state/__tests__/themeStore.test.ts`

Expected: FAIL because the new store and IO functions do not exist.

- [ ] **Step 3: Implement persistence and migration**

Use a dedicated `synax-theme-preferences` key. On hydration, prefer the new payload; otherwise read `rumbling-shell-preferences`, convert `theme` and `accentColor` to a normalized theme, persist the new payload, and leave non-theme shell preferences untouched. Make storage access guarded for tests and unavailable browser storage.

- [ ] **Step 4: Implement runtime synchronization**

`startThemeRuntime()` applies the current resolved mode immediately, listens to `prefers-color-scheme` only while mode is `system`, subscribes to theme-store changes, and listens to the dedicated storage key. `ThemeState` should expose `resolvedTokens` for terminal and other JS consumers without requiring components to inspect DOM styles.

- [ ] **Step 5: Wire app bootstrap and remove theme ownership from shell store**

Change `main.tsx` to hydrate and start the theme store before React renders. Remove theme-specific setters, fields, and persistence branches from `shellStore.ts`; keep compatibility exports only if existing tests/importers require them, delegating to the new theme store during the migration window.

- [ ] **Step 6: Run focused tests and commit**

Run: `npm exec vitest run web/src/react/state/__tests__/themeStore.test.ts web/src/lib/appearance.test.ts`

Expected: PASS.

Commit only Task 3 files:

```bash
git add web/src/lib/theme/io.ts web/src/react/state/themeStore.ts web/src/react/state/__tests__/themeStore.test.ts web/src/react/state/shellStore.ts web/src/main.tsx && git commit -m "refactor: isolate theme state and persistence"
```

## Task 4: Migrate JS consumers and terminal styling

**Files:**
- Modify: `web/src/react/components/ThemeToggle.tsx`
- Modify: `web/src/react/layouts/ActivityBar.tsx`
- Modify: `web/src/react/layouts/ProjectLayout.tsx`
- Modify: `web/src/lib/electron-menu.ts`
- Modify: `web/src/react/features/terminal/TerminalViewport.tsx`
- Test: existing consumer tests plus the terminal theme test seam.

**Interfaces:**
- Consumes `useThemeStore`, `getResolvedThemeTokens()`, and `toggleMode()` from Task 3.
- Produces no new public API; all consumers stop reading theme state from `shellStore`.

- [ ] **Step 1: Update consumer tests to use the theme store boundary**

Replace shell-store theme fixtures in `ThemeToggle.test.tsx` and relevant layout tests with a resettable theme-store fixture. Add an assertion that toggling changes only the theme store and not unrelated shell preferences.

- [ ] **Step 2: Run consumer tests and verify they fail at the old boundary**

Run: `npm exec vitest run web/src/react/components/__tests__/ThemeToggle.test.tsx web/src/react/layouts`

Expected: FAIL or type errors because the consumers still import the shell-store theme selectors.

- [ ] **Step 3: Migrate controls and menus**

Use `useThemeStore((state) => state.resolvedTheme)` and theme actions in the React components. In `electron-menu.ts`, call the store action rather than mutating shell preferences. Keep `light`/`dark` toggle behavior unchanged.

- [ ] **Step 4: Migrate terminal theme derivation**

Replace `accentPalette()` and shell-store reads with `getResolvedThemeTokens()`. Map semantic values to xterm `background`, `foreground`, `cursor`, `selectionBackground`, black, and brightBlack. Subscribe to theme changes so an already-open terminal updates without recreating its connection.

- [ ] **Step 5: Run consumer tests and commit**

Run: `npm exec vitest run web/src/react/components/__tests__/ThemeToggle.test.tsx web/src/react/features/settings/components/__tests__/AppearanceSection.test.tsx`

Expected: PASS for migrated consumers; no theme reads remain in the listed files.

Commit only Task 4 files:

```bash
git add web/src/react/components/ThemeToggle.tsx web/src/react/layouts/ActivityBar.tsx web/src/react/layouts/ProjectLayout.tsx web/src/lib/electron-menu.ts web/src/react/features/terminal/TerminalViewport.tsx web/src/react/components/__tests__/ThemeToggle.test.tsx && git commit -m "refactor: migrate theme consumers"
```

## Task 5: Add settings-page import/export/reset controls

**Files:**
- Modify: `web/src/react/features/settings/components/AppearanceSection.tsx`
- Modify: `web/src/react/features/settings/components/appearance.css`
- Modify: `web/src/react/features/settings/components/__tests__/AppearanceSection.test.tsx`
- Modify: `web/src/lib/theme/io.ts` if browser download/file input seams need test injection.

**Interfaces:**
- Consumes `useThemeStore` actions and import result from Task 3.
- Produces accessible controls for import, export, reset, and current theme metadata.

- [ ] **Step 1: Write failing component tests**

Add tests that:

```ts
it("shows imported theme metadata and exposes reset", async () => {
  seedThemeStore({ source: "imported", activeTheme: makeTheme("mist-blue", "雾蓝") });
  render(<AppearanceSection />);
  expect(screen.getByText("雾蓝")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /恢复默认|reset/i }));
  expect(themeActions.resetTheme).toHaveBeenCalled();
});

it("reports an invalid import without changing the active theme", async () => {
  mockThemeImport({ ok: false, error: "Invalid theme file" });
  render(<AppearanceSection />);
  await userEvent.upload(screen.getByLabelText(/导入主题|import theme/i), new File(["{}"], "bad.json"));
  expect(await screen.findByRole("alert")).toHaveTextContent(/invalid/i);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm exec vitest run web/src/react/features/settings/components/__tests__/AppearanceSection.test.tsx`

Expected: FAIL because the new metadata and IO controls are not rendered.

- [ ] **Step 3: Implement controls and localized feedback**

Keep the existing mode/preset/color picker interactions. Add a visually consistent theme metadata row and hidden file input with an accessible label. Disable reset when the built-in default is active. Show success/error feedback using the existing settings/toast conventions without changing the active theme before validation succeeds.

- [ ] **Step 4: Implement export and reset**

Wire export to a deterministic download filename `<theme-id>.synax-theme.json`; wire reset to the store. Keep preview DOM on semantic variables so it updates automatically.

- [ ] **Step 5: Style and run focused tests**

Use existing appearance CSS tokens for borders, text, focus outline, and buttons. Run:

```bash
npm exec vitest run web/src/react/features/settings/components/__tests__/AppearanceSection.test.tsx web/src/react/features/settings/components/__tests__/AccentColorPicker.test.tsx
```

Expected: PASS.

Commit only Task 5 files:

```bash
git add web/src/react/features/settings/components/AppearanceSection.tsx web/src/react/features/settings/components/appearance.css web/src/react/features/settings/components/__tests__/AppearanceSection.test.tsx web/src/lib/theme/io.ts && git commit -m "feat: add theme import and export controls"
```

## Task 6: Complete semantic CSS migration and compatibility cleanup

**Files:**
- Modify: `web/src/index.css`
- Modify: `web/src/react/design/tokens.css`
- Modify component CSS files identified by the token audit, prioritizing settings, workbench, dialogs, menus, buttons, terminal shells, and notifications.
- Test: `web/src/react/design/tokens.test.ts` plus a new grep-based token audit test if needed.

**Interfaces:**
- Consumes the stable CSS variables from Task 2.
- Produces no new runtime API; ensures existing components no longer bypass theme semantics for the migrated visual surfaces.

- [ ] **Step 1: Add a token audit test**

Scan the CSS files in the targeted component directories and assert that known theme-specific literals from the old palette are absent except in `defaults.ts`, fixtures, and documented previews. Assert that required `--theme-*` names exist in `tokens.css`.

- [ ] **Step 2: Run the audit and record failures**

Run: `npm exec vitest run web/src/react/design/tokens.test.ts`

Expected: FAIL only for files still using the old direct theme values.

- [ ] **Step 3: Replace targeted literals with semantic variables**

Change only colors, borders, shadows, and theme-dependent backgrounds in the listed surfaces. Preserve layout values and component-specific status semantics. Use `color-mix()` only where the existing browser support and token model already allow it; otherwise define a semantic token in the theme contract.

- [ ] **Step 4: Run typecheck and CSS contract tests**

Run: `npm exec vitest run web/src/react/design/tokens.test.ts web/src/lib/theme/__tests__/*.test.ts && npm run --prefix web build`

Expected: PASS with no missing CSS variables or TypeScript errors.

- [ ] **Step 5: Commit cleanup**

```bash
git add web/src/index.css web/src/react/design/tokens.css web/src/react/design web/src/react/components web/src/react/features web/src/react/layouts && git commit -m "refactor: migrate UI styles to theme tokens"
```

Only include files changed for this task; do not stage unrelated working-tree changes.

## Task 7: Full verification and documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-09-28-theme-system-refactor-design.md` only if implementation details materially differ.
- Create: `docs/design/theme-file-format.md` — user-facing JSON format and examples, if the project documentation convention accepts it.
- Test/outputs: existing `.tmp` or `out/` QA artifacts, never commit generated screenshots or `.DS_Store`.

- [ ] **Step 1: Run focused theme test suite**

Run:

```bash
npm exec vitest run web/src/lib/theme web/src/react/state/__tests__/themeStore.test.ts web/src/react/components/__tests__/ThemeToggle.test.tsx web/src/react/features/settings/components/__tests__/AppearanceSection.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run full web typecheck/build**

Run: `npm run --prefix web build`

Expected: PASS.

- [ ] **Step 3: Run repository typecheck and relevant smoke tests**

Run: `npm run typecheck && npm run test:visualize:web` only if the existing web smoke prerequisites are available; otherwise run the project’s existing browser smoke command and record the unavailable prerequisite rather than modifying unrelated infrastructure.

Expected: PASS or a documented environment-only limitation.

- [ ] **Step 4: Verify git hygiene**

Run: `git status --short --branch` and `git diff --check`. Confirm no `.DS_Store`, generated `dist/`, or unrelated pre-existing files are staged.

- [ ] **Step 5: Commit documentation/verification-only changes**

```bash
git add docs/design/theme-file-format.md docs/superpowers/specs/2026-09-28-theme-system-refactor-design.md
git commit -m "docs: document theme file format"
```

Do not commit generated QA artifacts.
