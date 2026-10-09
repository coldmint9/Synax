import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import postcss from "postcss";

const base = readFileSync(resolve(import.meta.dirname, "../../../index.css"), "utf8");
const work = readFileSync(resolve(import.meta.dirname, "../workPage.css"), "utf8");

function declarationsIn(css: string, selector: string) {
  const result: Record<string, string> = {};
  postcss.parse(css).walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    rule.walkDecls((decl) => { result[decl.prop] = decl.value; });
  });
  return result;
}

describe("conversation row states", () => {
  it("never applies row hover backgrounds to the selected conversation", () => {
    const rules: string[] = [];
    for (const css of [base, work]) {
      postcss.parse(css).walkRules((rule) => {
        // Ignore rules that only reveal the row's action button.
        if (!rule.nodes.some((node) => node.type === "decl" && node.prop === "background")) return;
        for (const selector of rule.selectors) {
          if (selector.includes(".session-list-item") && selector.includes(":hover")) {
            rules.push(selector);
            expect(selector).toContain(":not(.session-list-item--active)");
          }
        }
      });
    }
    expect(rules.length).toBeGreaterThan(0);
  });

  it("uses a flat, outlined hover with equivalent keyboard feedback", () => {
    expect(base).toContain(".session-list-item:not(.session-list-item--active):hover");
    expect(base).toContain(".session-list-item:not(.session-list-item--active):has(> .session-list-select:focus-visible)");
    expect(base).toContain("border-color: color-mix(in srgb, var(--ui-text) 16%, transparent)");
    expect(base).toContain("background-color 140ms ease, border-color 140ms ease");
    expect(work).toContain("box-shadow: var(--ui-shadow-control)");
  });

  it("paints the selected row with the theme accent in both modes", () => {
    const baseActive = declarationsIn(base, ".session-list-item--active");
    const workActive = declarationsIn(work, ".work-page .session-list-item--active");
    const darkActive = declarationsIn(work, ".dark .work-page .session-list-item--active");

    for (const active of [baseActive, workActive, darkActive]) {
      expect(active.background).toBe("var(--session-row-active-surface)");
    }
    // The old light-mode fill was a neutral gray, which vanished against the
    // near-white sidebar; the accent tint is now the only source of selection.
    expect(baseActive.background).not.toContain("cx-gray");
    expect(baseActive.background).not.toContain("ui-panel");
    expect(baseActive["border-color"]).toBe("var(--session-row-active-border)");
    expect(base).toContain("--session-row-active-surface: color-mix(");
    expect(base).toContain("var(--theme-accent) 30%,");
    expect(base).toContain("--session-row-active-border: color-mix(");
  });

  it("restores preview contrast on the tinted selected row", () => {
    for (const [css, selector] of [
      [base, ".session-list-item--active .session-list-preview"],
      [work, ".work-page .session-list-item--active .session-list-preview"],
    ]) {
      expect(declarationsIn(css, selector).color).toBe(
        "color-mix(in srgb, var(--ui-text) 92%, transparent)",
      );
    }
  });

  it("keeps dark selected rows elevated above the sidebar fill", () => {
    const active = declarationsIn(work, ".dark .work-page .session-list-item--active");
    const hover = declarationsIn(work, ".dark .work-page .session-list-item:not(.session-list-item--active):hover");
    expect(active.background).not.toBe("hsl(var(--secondary))");
    expect(hover.background).toBeDefined();
    expect(active.background).not.toBe(hover.background);
    expect(active["border-color"]).toBe("var(--session-row-active-border)");
    expect(active["box-shadow"]).toContain("inset");
    expect(hover["box-shadow"]).toBe("none");
  });

  it("keeps conversation titles at 13px in both base and workspace styles", () => {
    for (const [css, selector] of [[base, ".session-list-title"], [work, ".work-page .session-list-title"]]) {
      let size: string | undefined;
      postcss.parse(css).walkRules((rule) => {
        if (rule.selector !== selector) return;
        rule.walkDecls("font-size", (decl) => { size = decl.value; });
      });
      expect(size).toBe("13px");
    }
  });
});
