import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import {
  DashboardPanel,
  WorkspaceDashboardLayout,
} from "../WorkspaceDashboardLayout";
import {
  useDashboardLayoutStore,
  DASHBOARD_LAYOUT_KEY,
} from "../state/dashboardLayoutStore";
import { useShellStore } from "../../../state/shellStore";

beforeEach(() => {
  localStorage.removeItem(DASHBOARD_LAYOUT_KEY);
  useDashboardLayoutStore.setState({ layouts: {} });
  useShellStore.setState((s) => ({
    preferences: { ...s.preferences, locale: "en" },
  }));
});
afterEach(cleanup);
function Panels({
  showGit = true,
  scope = "project",
}: {
  showGit?: boolean;
  scope?: string;
}) {
  return (
    <WorkspaceDashboardLayout scope={scope}>
      {showGit && (
        <DashboardPanel id="git" label="Git">
          <section className="ws-card" data-open="true">
            <div className="ws-card-head">Git changes</div>
            <div className="ws-card-body">Files</div>
          </section>
        </DashboardPanel>
      )}
      <DashboardPanel id="processes" label="Processes">
        <section className="ws-card" data-open="true">
          <div className="ws-card-head">Processes</div>
          <div className="ws-card-body">Logs</div>
        </section>
      </DashboardPanel>
      <DashboardPanel id="runtime" label="Runtime">
        <section className="ws-card" data-open="false">
          <div className="ws-card-head">Runtime</div>
        </section>
      </DashboardPanel>
    </WorkspaceDashboardLayout>
  );
}
const order = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[data-dashboard-panel]")].map(
    (el) => el.dataset.dashboardPanel,
  );

describe("custom dashboard layout", () => {
  it("reorders with keyboard, preserves temporarily absent panels, and restores after remount", () => {
    const view = render(<Panels />);
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Move panel: Processes" }),
      { key: "ArrowUp" },
    );
    expect(order(view.container)).toEqual(["processes", "git", "runtime"]);
    expect(
      JSON.parse(localStorage.getItem(DASHBOARD_LAYOUT_KEY)!).project.order,
    ).toEqual(["processes", "git", "runtime"]);
    view.rerender(<Panels showGit={false} />);
    expect(order(view.container)).toEqual(["processes", "runtime"]);
    view.rerender(<Panels />);
    expect(order(view.container)).toEqual(["processes", "git", "runtime"]);
    view.unmount();
    expect(order(render(<Panels />).container)).toEqual([
      "processes",
      "git",
      "runtime",
    ]);
  });
  it("resizes within bounds, resets one panel, and isolates workspace preferences", () => {
    const view = render(<Panels />);
    const panel = view.container.querySelector<HTMLElement>(
      '[data-dashboard-panel="git"]',
    )!;
    Object.defineProperty(panel, "offsetHeight", {
      get: () => parseFloat(panel.style.height) || 200,
    });
    const resize = screen.getByRole("button", {
      name: "Resize panel height: Git",
    });
    fireEvent.keyDown(resize, { key: "ArrowLeft" });
    expect(
      view.container.querySelector('[data-dashboard-panel="git"]'),
    ).not.toHaveAttribute("style");
    expect(useDashboardLayoutStore.getState().layouts.project).toBeUndefined();
    fireEvent.keyDown(resize, { key: "ArrowDown" });
    expect(
      useDashboardLayoutStore.getState().layouts.project.sizes.git,
    ).toEqual({ width: 1, height: 212 });
    for (let i = 0; i < 50; i++)
      fireEvent.keyDown(resize, { key: "ArrowDown", shiftKey: true });
    expect(
      useDashboardLayoutStore.getState().layouts.project.sizes.git.height,
    ).toBe(900);
    view.rerender(<Panels scope="other" />);
    expect(
      view.container.querySelector('[data-dashboard-panel="git"]'),
    ).not.toHaveAttribute("style");
    view.rerender(<Panels />);
    expect(
      view.container.querySelector('[data-dashboard-panel="git"]'),
    ).toHaveStyle({ height: "900px" });
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "Resize panel height: Git" }),
    );
    expect(
      useDashboardLayoutStore.getState().layouts.project.sizes.git,
    ).toBeUndefined();
  });
  it("restores default order and sizes together", () => {
    const view = render(<Panels />);
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Move panel: Runtime" }),
      { key: "ArrowUp" },
    );
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Resize panel height: Git" }),
      { key: "ArrowLeft" },
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset layout" }));
    expect(order(view.container)).toEqual(["git", "processes", "runtime"]);
    expect(useDashboardLayoutStore.getState().layouts.project).toBeUndefined();
  });
});
