import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import postcss from "postcss";

const base = readFileSync(resolve(import.meta.dirname, "../../../../index.css"), "utf8");
const work = readFileSync(resolve(import.meta.dirname, "../workPage.css"), "utf8");

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

  it("gives dark selected rows their own elevated surface instead of the sidebar fill", () => {
    const root = postcss.parse(work);
    const declarations = (selector: string) => {
      const result: Record<string, string> = {};
      root.walkRules((rule) => {
        if (!rule.selectors.includes(selector)) return;
        rule.walkDecls((decl) => { result[decl.prop] = decl.value; });
      });
      return result;
    };
    const active = declarations(".dark .work-page .session-list-item--active");
    const hover = declarations(".dark .work-page .session-list-item:not(.session-list-item--active):hover");
    expect(active.background).not.toBe("hsl(var(--secondary))");
    expect(active.background).toContain("var(--ui-panel-soft)");
    expect(hover.background).toBeDefined();
    expect(active.background).not.toBe(hover.background);
    expect(active["border-color"]).toBeDefined();
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
