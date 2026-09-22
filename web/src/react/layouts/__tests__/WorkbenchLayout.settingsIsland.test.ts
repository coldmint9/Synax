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
    if (rule.parent?.type === "atrule" && rule.parent.name === "media") return;
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
  expect(declaration(macHeader, "left")).toBe(
    declaration(".workbench-header", "left"),
  );
  expect(declaration(macHeader, "top")).toBe(
    declaration(".workbench-header", "top"),
  );
  expect(declaration(macHeader, "-webkit-app-region")).toBe("no-drag");
  const emptyHeader =
    '.workbench-shell[data-has-project="false"] .workbench-header';
  for (const property of ["left", "top", "transform", "-webkit-app-region"])
    expect(declaration(emptyHeader, property)).toBeUndefined();
});


describe("Wiki and Work island alignment", () => {
  it("moves only the Wiki group another 40px left", () => {
    const workOffset = declaration(".workbench-header", "--island-center-offset");
    const wikiOffset = declaration(
      '.workbench-shell[data-active-panel="wiki"] .workbench-header',
      "--island-center-offset",
    );
    expect(parseFloat(workOffset!) - parseFloat(wikiOffset!)).toBe(40);
  });

  it("uses the same top inset for global and conversation islands", () => {
    expect(declaration(".workbench-shell", "--workbench-island-top")).toBe("8px");
    for (const selector of [
      ".workbench-header",
      ".electron-macos .workbench-header",
      '.workbench-shell[data-active-panel="settings"] .workbench-header',
    ]) {
      expect(declaration(selector, "top")).toBe("var(--workbench-island-top)");
    }
    expect(declaration(".workspace-island-slot--conversation", "top", workPageStylesheet))
      .toBe("var(--workbench-island-top)");
  });

  it("centers the group on the content-column anchor with Wiki tools in flow", () => {
    expect(declaration(".workbench-header", "--island-center-offset")).toBe("130px");
    expect(declaration(".workbench-header", "left")).toBe("calc(50% + var(--island-center-offset))");
    expect(declaration(".workbench-header > .wh-pill-slot", "position")).toBeUndefined();
    expect(declaration(".wh-pill-slot", "width")).toBe("0");
    expect(declaration(".wh-pill-slot.open", "width")).toBe("calc(var(--toolbar-width, 0px) + 8px)");
    expect(declaration(".wh-pill-slot", "transition")).toContain("width 280ms");
    expect(declaration(".workbench-header > .wh-pill", "flex-shrink")).toBe("0");
  });
});


it("leaves vertical room for the navigation pill shadow without shifting the header", () => {
  const scroller = ".wh-tabs .tabs__list-container__scroller";
  expect(declaration(scroller, "padding-block")).toBe("6px");
  expect(declaration(scroller, "margin-block")).toBe("-6px");
  expect(declaration(".wh-tabs .tabs__tab", "height")).toBe("26px");
  expect(declaration(scroller, "overflow")).toBeUndefined();
});
