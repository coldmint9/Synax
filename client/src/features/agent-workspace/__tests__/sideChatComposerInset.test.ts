import postcss from "postcss";
import { describe, expect, it } from "vitest";
import css from "../workPage.css?raw";
import { SIDE_CHAT_COMPOSER_INSET } from "../useComposerOverlayInset";

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

describe("side-chat composer inset", () => {
  it("reserves the measured composer height inside the transcript content", () => {
    const expected = `var(${SIDE_CHAT_COMPOSER_INSET}, 0px)`;
    expect(
      declaration(
        ".side-chat-body .session-workspace-scroll-content",
        "padding-bottom",
      ),
    ).toBe(expected);
    expect(
      declaration(
        ".side-chat-body > .session-workspace-scroll",
        "scroll-padding-bottom",
      ),
    ).toBe(expected);
  });
});
