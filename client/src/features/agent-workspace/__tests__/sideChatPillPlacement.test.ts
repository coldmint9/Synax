import postcss from "postcss";
import { describe, expect, it } from "vitest";
import css from "../workPage.css?raw";

const stylesheet = postcss.parse(css);

function declaration(selector: string, property: string) {
  let value: string | undefined;
  stylesheet.walkRules(rule => {
    if (rule.selector.replace(/\s+/g, " ").trim() !== selector) return;
    rule.walkDecls(property, declaration => {
      value = declaration.value.replace(/\s+/g, " ").trim();
    });
  });
  return value;
}

describe("collapsed side-chat tab", () => {
  it("rests in the top gutter instead of the turn rail's centre band", () => {
    // The conversation turn rail is centred on this edge; a centred tab sat on
    // top of one tick and swallowed its hover target.
    expect(declaration(".side-chat-pill", "top")).toBe("0.5rem");
    expect(declaration(".side-chat-pill", "transform")).toBeUndefined();
    expect(declaration(".side-chat-pill", "right")).toBe("0");
  });
});
