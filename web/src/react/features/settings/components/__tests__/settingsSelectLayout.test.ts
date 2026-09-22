import { describe, expect, it } from "vitest";
import postcss from "postcss";
import css from "../../../../../index.css?raw";

const stylesheet = postcss.parse(css);
function declaration(selector: string, property: string) {
  let value: string | undefined;
  stylesheet.walkRules(selector, (rule) => {
    rule.walkDecls(property, (decl) => { value = decl.value; });
  });
  return value;
}

describe("compact settings select alignment", () => {
  it("centers the value vertically in the 30px trigger", () => {
    expect(declaration(":root .settings-select .select__trigger", "height")).toBe("30px");
    expect(declaration(":root .settings-select .select__trigger", "align-items")).toBe("center");
    expect(declaration(":root .settings-select .select__value", "align-items")).toBe("center");
    expect(declaration(":root .settings-select .select__value", "font-size")).toBe("inherit");
    expect(declaration(":root .settings-select .select__value", "line-height")).toBe("20px");
  });
  it("reserves space for the indicator without offsetting the value vertically", () => {
    expect(declaration(":root .settings-select .select__trigger:has(.select__indicator)", "padding-inline-end")).toBe("28px");
  });
});
