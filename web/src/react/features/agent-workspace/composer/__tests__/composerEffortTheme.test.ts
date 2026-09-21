import postcss from "postcss";
import { describe, expect, it } from "vitest";
import css from "../composerEffortPicker.css?raw";

const stylesheet = postcss.parse(css);
function declarations(selector: string) {
  const result: Record<string, string> = {};
  stylesheet.walkRules(selector, (rule) => {
    rule.walkDecls((declaration) => {
      result[declaration.prop] = declaration.value;
    });
  });
  return result;
}

describe("effort picker theme", () => {
  it("overrides all appearance tokens on the portalled content in dark mode", () => {
    const light = declarations(".composer-effort-picker");
    const dark = declarations(".dark .composer-effort-picker");
    expect(Object.keys(light).length).toBeGreaterThan(0);
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
    for (const token of Object.keys(light)) {
      expect(dark[token], token).not.toBe(light[token]);
    }
  });

  it("uses theme tokens for hover, keyboard focus, and selected markers", () => {
    expect(declarations(".composer-effort-station:hover").background).toBe(
      "var(--effort-station-hover)",
    );
    expect(
      declarations(".composer-effort-station:focus-visible").background,
    ).toBe("var(--effort-station-focus)");
    expect(
      declarations(
        '.composer-effort-station[aria-checked="true"] .composer-effort-dot',
      ).background,
    ).toBe("var(--effort-dot-selected)");
  });
});
