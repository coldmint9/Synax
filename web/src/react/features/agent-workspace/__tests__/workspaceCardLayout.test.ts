import css from "../workPage.css?raw";
import dashboardCss from "../workspaceDashboardLayout.css?raw";
import { describe, expect, it } from "vitest";
import postcss from "postcss";

const workStylesheet = postcss.parse(css);
const dashboardStylesheet = postcss.parse(dashboardCss);

function declaration(
  stylesheet: ReturnType<typeof postcss.parse>,
  selector: string,
  property: string,
) {
  let value: string | undefined;
  stylesheet.walkRules((rule) => {
    if (rule.selector.replace(/\s+/g, " ").trim() !== selector) return;
    rule.walkDecls(property, (decl) => {
      value = decl.value.replace(/\s+/g, " ").trim();
    });
  });
  return value;
}

describe("workspace card layout", () => {
  it("separates dashboard panels into independent cards", () => {
    expect(
      declaration(
        dashboardStylesheet,
        ":is(.work-page, .work-details-dialog) .workspace-dashboard--custom, .workspace-dashboard--custom",
        "gap",
      ),
    ).toBe("8px");
    expect(
      declaration(
        dashboardStylesheet,
        ".workspace-dashboard--custom .dashboard-panel",
        "border",
      ),
    ).toBe("1px solid var(--work-panel-edge, hsl(var(--border-hsl) / 0.28))");
    expect(
      declaration(
        dashboardStylesheet,
        ".workspace-dashboard--custom .dashboard-panel",
        "background",
      ),
    ).toBe("var(--work-surface, var(--surface))");
    expect(
      declaration(
        dashboardStylesheet,
        ".workspace-dashboard--custom .dashboard-panel",
        "box-shadow",
      ),
    ).toBe("var(--surface-shadow)");
  });

  it("keeps the sidebar transparent and removes the continuous card divider", () => {
    expect(
      declaration(
        workStylesheet,
        ".work-page .session-workspace-sidebar--dock",
        "border",
      ),
    ).toBe("0");
    expect(
      declaration(
        workStylesheet,
        ":is(.work-page, .work-details-dialog) .ws-card",
        "border-bottom",
      ),
    ).toBeUndefined();
  });

  it("does not nest a second shell inside the runtime panel card", () => {
    expect(
      declaration(
        dashboardStylesheet,
        ".workspace-dashboard--custom .runtime-profile .runtime-profile-card",
        "border",
      ),
    ).toBe("0");
    expect(
      declaration(
        dashboardStylesheet,
        ".workspace-dashboard--custom .runtime-profile .runtime-profile-card",
        "background",
      ),
    ).toBe("transparent");
    expect(
      declaration(
        dashboardStylesheet,
        ".workspace-dashboard--custom .runtime-profile .runtime-profile-card",
        "box-shadow",
      ),
    ).toBe("none");
  });
});
