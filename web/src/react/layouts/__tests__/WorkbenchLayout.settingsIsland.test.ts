import postcss from "postcss";
import { describe, expect, it } from "vitest";
import css from "../../../index.css?raw";
import workPageCss from "../../features/agent-workspace/workPage.css?raw";
import layoutSource from "../WorkbenchLayout.tsx?raw";

const stylesheet = postcss.parse(css);
const workPageStylesheet = postcss.parse(workPageCss);

function declaration(selector: string, property: string, root = stylesheet) {
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

describe("empty workspace island layout", () => {
  it("removes the sidebar offset when no project is selected", () => {
    expect(layoutSource).toContain("data-has-project={!!effectiveProjectId}");
    expect(
      declaration(
        '.workbench-shell[data-has-project="false"] .workbench-header',
        "--island-center-offset",
      ),
    ).toBe("0px");
  });
});

it("preserves macOS titlebar positioning and non-drag island behavior", () => {
  const macHeader = ".electron-macos .workbench-header";
  expect(declaration(macHeader, "left")).toBe("50%");
  expect(declaration(macHeader, "top")).toBe("15px");
  expect(declaration(macHeader, "-webkit-app-region")).toBe("no-drag");
  const emptyHeader =
    '.workbench-shell[data-has-project="false"] .workbench-header';
  for (const property of ["left", "top", "transform", "-webkit-app-region"])
    expect(declaration(emptyHeader, property)).toBeUndefined();
});
