import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { expect, it } from "vitest";

const base = postcss.parse(readFileSync(resolve(import.meta.dirname, "../../../index.css"), "utf8"));
const work = postcss.parse(readFileSync(resolve(import.meta.dirname, "../workPage.css"), "utf8"));
const declarations = (root: postcss.Root, selector: string, media = false) => {
  const values: Record<string, string> = {};
  root.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    const inMedia = rule.parent?.type === "atrule" && rule.parent.name === "media";
    if (inMedia !== media) return;
    rule.walkDecls((decl) => { values[decl.prop] = decl.value; });
  });
  return values;
};

it("clips titles without an ellipsis while retaining ellipses for message previews", () => {
  expect(declarations(base, ".session-list-title-viewport")["text-overflow"]).toBe("clip");
  expect(declarations(base, ".session-list-title")["text-overflow"]).toBeUndefined();
  expect(declarations(base, ".session-list-preview")["text-overflow"]).toBe("ellipsis");
});

it("reserves action space only while visible, including persistent touch actions", () => {
  expect(declarations(work, ".work-page .session-list-select")["padding-right"]).toBe("8px");
  expect(declarations(base, ".session-list-item:is(:hover, :focus-within) > .session-list-select")["padding-right"]).toBe("28px");
  expect(declarations(work, ".work-page .session-list-select", true)["padding-right"]).toBe("28px");
  expect(declarations(base, ".session-list-delete").right).toBe("4px");
});

it("fades and blurs only the overflowing right edge and exempts the final position", () => {
  const sharp = declarations(base, '.session-list-title-viewport[data-overflow="true"]:not([data-at-end="true"]) > .session-list-title-sharp');
  expect(sharp["mask-image"]).toContain("100% - 20px");
  const blur = declarations(base, ".session-list-title-blur-text");
  expect(blur.filter).toBe("blur(0.8px)");
  expect(blur["backdrop-filter"]).toBeUndefined();
  expect(declarations(base, ".session-list-title-blur")["pointer-events"]).toBe("none");
});
