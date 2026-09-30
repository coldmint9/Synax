import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import postcss from "postcss";

const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");
const tokens = read("../../../design/tokens.css");
const base = read("../../../../index.css");
const work = read("../workPage.css");
function rule(css: string, selector: string) {
  const values: Record<string, string> = {};
  postcss.parse(css).walkRules((item) => {
    if (item.selector === selector) item.walkDecls((decl) => { values[decl.prop] = decl.value; });
  });
  return values;
}

it("uses the bundled interface stack and readable body sizing without altering the rem scale", () => {
  expect(rule(tokens, ":root")["--font-interface"]).toContain('"Inter Variable"');
  expect(rule(tokens, ":root")["--font-interface"]).toContain('"Noto Sans SC Variable"');
  expect(rule(base, "body")["font-family"]).toBe("var(--font-interface)");
  expect(rule(base, "body")["font-size"]).toBe("14px");
  expect(rule(base, "body")["font-weight"]).toBe("450");
  expect(rule(base, "body")["letter-spacing"]).toBe("-0.012em");
  expect(rule(base, "html")["font-size"]).toBeUndefined();
  expect(base).toContain('--font-mono: "JetBrains Mono"');
});

it("uses the requested title-only geometry with a line height that fits 30px", () => {
  const compact = rule(work, ".work-page .session-list-item--title-only .session-list-select");
  expect(compact["min-height"]).toBe("30px");
  expect(compact["padding-block"]).toBe("5px");
  expect(rule(work, ".work-page .session-list-title")["line-height"]).toBe("18px");
});
