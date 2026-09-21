import postcss from "postcss";
import { describe, expect, it } from "vitest";
import css from "../../../index.css?raw";
import workPageCss from "../../features/agent-workspace/workPage.css?raw";
import layoutSource from "../WorkbenchLayout.tsx?raw";

const stylesheet = postcss.parse(css);
const workPageStylesheet = postcss.parse(workPageCss);

function declaration(
  selector: string,
  property: string,
  root = stylesheet,
) {
  let value: string | undefined;
  root.walkRules((rule) => {
    if (rule.selector.replace(/\s+/g, " ").trim() !== selector) return;
    rule.walkDecls(property, (decl) => {
      value = decl.value;
    });
  });
  return value;
}

describe("settings island layout", () => {
  it("marks the active route and removes the session-sidebar offset on settings", () => {
    expect(layoutSource).toContain(
      "data-active-panel={activePanel ?? undefined}",
    );
    const settingsHeader =
      '.workbench-shell[data-active-panel="settings"] .workbench-header';
    expect(declaration(settingsHeader, "--island-center-offset")).toBe("0px");
    expect(declaration(settingsHeader, "top")).toBe(
      declaration(
        ".workspace-island-slot--conversation",
        "top",
        workPageStylesheet,
      ),
    );
  });
});
