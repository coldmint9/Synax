import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(import.meta.dirname, "../composerModes.css"), "utf8");
const controls = readFileSync(resolve(import.meta.dirname, "../agentControls.css"), "utf8");
const git = readFileSync(resolve(import.meta.dirname, "../git-actions/gitActions.css"), "utf8");
const composer = readFileSync(resolve(import.meta.dirname, "../SessionComposer.tsx"), "utf8");
const rule = (source: string, selector: string) => {
  const start = source.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf("}", start) + 1);
};

describe("neutral composer surfaces", () => {
  it("removes decorative mode DOM, asymmetric borders, dots, washes and sweeps", () => {
    expect(composer).not.toContain("agent-composer-mode-frame");
    expect(css).not.toMatch(/mode-frame|mode-sweep|mode-cap|border-inline-start|gradient\(|@keyframes|text-shadow/);
    expect(css).toContain(".agent-composer-mode-mark");
    expect(composer).toContain("aria-label={composerModeMark.label}");
  });

  it("keeps a neutral surface and visible focus in light, dark and forced colors", () => {
    const shell = ".agent-session-controls .agent-session-composer-shell.agent-dock-shell";
    expect(rule(controls, shell)).toContain("border: 1px solid");
    expect(rule(controls, shell)).toContain("border-radius: 14px");
    expect(rule(controls, shell)).toContain("background: hsl(var(--card))");
    expect(rule(controls, shell)).toContain("box-shadow: none");
    expect(rule(controls, `.dark ${shell}`)).toContain("background: hsl(var(--card))");
    expect(rule(controls, `${shell}:focus-within`)).toContain("outline: 2px solid");
    expect(controls).toContain("forced-colors: active");
    expect(controls).toContain("border-color: CanvasText");
    expect(controls).toContain("outline-color: Highlight");
    expect(rule(css, ".session-composer-mode-option:focus-visible")).toContain("outline: 2px solid");
    expect(css).toContain("prefers-reduced-motion: reduce");
  });

  it("marks beta modes with a quiet tag instead of decorative effects", () => {
    const badge = rule(css, ".session-composer-mode-beta");
    expect(badge).toContain("text-transform: uppercase");
    expect(badge).toContain("border: 1px solid");
    expect(badge).not.toMatch(/gradient|text-shadow/);
    expect(css.slice(css.indexOf("@media (forced-colors: active)"))).toContain(
      ".session-composer-mode-beta",
    );
  });

  it("aligns Git and orchestration at 32px, wraps and restores focusRail hit testing", () => {
    const row = rule(css, ".agent-session-action-row");
    expect(row).toContain("flex-wrap: wrap");
    expect(row).toContain("align-items: center");
    expect(row).toContain("pointer-events: auto");
    expect(rule(css, ".agent-session-action-row > .super-dag-trigger")).toContain("min-height: 32px");
    expect(rule(git, ".composer-git-actions .ui-button")).toContain("min-height: 32px");
    expect(rule(git, ".composer-git-actions")).toContain("flex-wrap: wrap");
    expect(rule(css, ".agent-session-action-row > .super-dag-card")).toContain("flex-basis: 100%");
    expect(rule(css, ".super-dag-trigger:focus-visible")).toContain("border-color: var(--theme-focus)");
    expect(rule(git, ".composer-git-actions .ui-button:focus-visible")).toContain("border-color: var(--theme-focus)");
  });

  it("keeps alerts compact, selectable and fully readable rather than truncating diagnostics", () => {
    expect(rule(css, ".agent-composer-notice")).toContain("font-size: 0.75rem");
    expect(rule(css, ".agent-composer-notice")).toContain("color: var(--foreground)");
    expect(css).not.toContain("hsl(var(--foreground))");
    expect(rule(css, ".agent-composer-notice")).toContain("pointer-events: auto");
    const text = rule(css, ".agent-composer-notice > span");
    expect(text).toContain("overflow-wrap: anywhere");
    expect(text).toContain("white-space: pre-wrap");
    expect(text).not.toMatch(/line-clamp|text-overflow|max-height/);
  });
});
