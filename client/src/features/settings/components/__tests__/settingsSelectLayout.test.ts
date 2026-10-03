import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import postcss from "postcss";
import { AppSelect } from "../../../../shared/ui/AppSelect";
import css from "../../../../index.css?raw";

const stylesheet = postcss.parse(css);
function declaration(selector: string, property: string) {
  let value: string | undefined;
  stylesheet.walkRules(selector, (rule) => {
    rule.walkDecls(property, (decl) => { value = decl.value; });
  });
  return value;
}
function renderSelect() {
  render(createElement(AppSelect, {
    className: "settings-select",
    "aria-label": "Editor",
    value: "editor",
    options: [{ key: "editor", label: "External editor" }],
    onChange: vi.fn(),
  }));
  return screen.getByRole("button", { name: "Editor" });
}

describe("compact settings select alignment", () => {
  it("centers the actual Headless trigger and value in the 30px control", () => {
    const trigger = renderSelect();
    const selector = ':root .settings-select [aria-haspopup="listbox"]';
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger).toHaveClass("flex", "items-center");
    expect(declaration(selector, "height")).toBe("30px");
    expect(declaration(selector, "align-items")).toBe("center");
    expect(screen.getByText("External editor")).toHaveClass("min-w-0", "flex-1", "truncate");
  });
  it("reserves an in-flow indicator instead of an overlapping absolute slot", () => {
    const trigger = renderSelect();
    expect(trigger).toHaveClass("gap-2");
    const indicator = trigger.querySelector("svg");
    expect(indicator).toHaveAttribute("aria-hidden", "true");
    expect(indicator).toHaveClass("shrink-0");
    expect(indicator).not.toHaveClass("absolute");
  });
});
