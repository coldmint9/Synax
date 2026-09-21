import css from "../workPage.css?raw";
import { describe, expect, it } from "vitest";
import postcss from "postcss";

const stylesheet = postcss.parse(css);
function declaration(selector: string, property: string) {
  let value: string | undefined;
  stylesheet.walkRules((rule) => {
    if (rule.selector.replace(/\s+/g, " ").trim() !== selector) return;
    rule.walkDecls(property, (decl) => {
      value = decl.value;
    });
  });
  return value;
}

describe("workspace layout constraints", () => {
  it("centers the macOS task toolbar at the native traffic-light center", () => {
    const padding = declaration(
      ".electron-macos .work-page .session-list-card--sessions .session-list-header",
      "padding-top",
    );
    const rowHeight = declaration(
      ".electron-macos .work-page .session-list-titlebar-row",
      "height",
    );
    expect(padding).toBe("5px");
    expect(rowHeight).toBe("26px");
    expect(6 + 1 + parseFloat(padding!) + parseFloat(rowHeight!) / 2).toBe(
      18 + 14 / 2,
    );
  });

  it("does not reserve empty space between content-sized sidebar panels", () => {
    for (const selector of [
      ".workspace-dashboard--pinned .workspace-projects-pane",
      ":is(.work-page, .work-details-dialog) .workspace-dashboard--pinned > .bui-processes",
      '.workspace-dashboard--pinned > .work-runtime-details:has(> [data-open="true"])',
    ])
      expect(declaration(selector, "flex")).toBe("0 1 auto");
  });

  it("draws one divider between repository controls and project records", () => {
    expect(
      declaration(
        ":is(.work-page, .work-details-dialog) .ws-project-card > .ws-card-body",
        "border-top",
      ),
    ).toBe("0");
    expect(
      declaration(
        ":is(.work-page, .work-details-dialog) .ws-project-section",
        "border-top",
      ),
    ).toBe("1px solid var(--work-line)");
  });

  it("keeps the project header in place both at rest and when hovered", () => {
    const header = ":is(.work-page, .work-details-dialog) .ws-project-card > .ws-card-head";
    const selector = `${header}, ${header}:has(.ws-card-toggle:hover)`;
    expect(declaration(selector, "position")).toBe("relative");
    expect(declaration(selector, "top")).toBe("auto");
  });

  it("uses matching row padding and unclipped icon slots instead of offsets", () => {
    const repository = ":is(.work-page, .work-details-dialog) .ws-project-repository";
    const branch = `${repository} .ws-branch-trigger`;
    expect(declaration(repository, "padding")).toBe("0");
    expect(declaration(branch, "padding")).toBe("0 2px");
    expect(declaration(branch, "gap")).toBe("6px");
    expect(declaration(`${branch} > svg:first-child`, "inset-inline-start")).toBeUndefined();
    expect(declaration(".ws-branch-icon", "flex")).toBe("0 0 auto");
    expect(declaration(".ws-branch-icon", "overflow")).toBe("visible");
  });

  it("keeps Git actions on one row and lets the branch absorb width changes", () => {
    expect(declaration(".ws-repo-head", "flex-wrap")).toBe("nowrap");
    expect(declaration(".ws-branch-trigger.button", "flex")).toBe("1 1 0");
    expect(declaration(".ws-branch-trigger.button", "min-width")).toBe("0");
    expect(declaration(".ws-repo-head > .ws-icon-button", "flex")).toBe(
      "0 0 auto",
    );
    expect(declaration(".ws-repo-head > .ws-repo-action", "white-space")).toBe(
      "nowrap",
    );
  });
});
