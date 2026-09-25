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
  it("uses HeroUI surfaces in both themes without a separate material palette", () => {
    expect(declarations(".composer-effort-rail").background).toBe(
      "var(--default)",
    );
    expect(declarations(".composer-effort-fill").background).toBe("var(--accent)");
    expect(declarations(".composer-effort-thumb")["box-shadow"]).toBe(
      "var(--surface-shadow)",
    );
    expect(declarations(".dark .composer-effort-picker")).toEqual({});
  });

  it("uses theme tokens for hover, keyboard focus, and selected markers", () => {
    expect(declarations(".composer-effort-station:hover").background).toBe(
      "var(--default-hover)",
    );
    expect(
      declarations(".composer-effort-station:focus-visible").background,
    ).toBe("var(--default-hover)");
    expect(
      declarations(".composer-effort-station:focus-visible")["box-shadow"],
    ).toBe("0 0 0 2px var(--focus)");
    expect(
      declarations(
        '.composer-effort-station[aria-checked="true"] .composer-effort-dot',
      ).background,
    ).toBe("var(--accent)");
  });
});
