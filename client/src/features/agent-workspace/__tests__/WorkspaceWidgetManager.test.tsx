import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceWidget } from "../WorkspaceWidget";
import { WorkspaceDashboardLayout } from "../WorkspaceDashboardLayout";
import { WorkspaceWidgetManager } from "../WorkspaceWidgetManager";
import { DASHBOARD_LAYOUT_KEY, useDashboardLayoutStore } from "../state/dashboardLayoutStore";
import { useShellStore } from "../../../shared/state/shellStore";

beforeEach(() => {
  localStorage.removeItem(DASHBOARD_LAYOUT_KEY);
  useDashboardLayoutStore.setState({ layouts: {}, catalogs: {} });
  useShellStore.setState((s) => ({ preferences: { ...s.preferences, locale: "en" } }));
});
afterEach(cleanup);

function Dashboard() {
  return <WorkspaceDashboardLayout scope="project">
    <WorkspaceWidget id="files" label="Files"><div>File content</div></WorkspaceWidget>
    <WorkspaceWidget id="runtime" label="Runtime"><div>Runtime content</div></WorkspaceWidget>
  </WorkspaceDashboardLayout>;
}

it("manages registered widgets, preserves saved size/order, and isolates projects", async () => {
  const user = userEvent.setup();
  act(() => {
    useDashboardLayoutStore.getState().resize("project", "files", { width: 1, height: 350 });
    useDashboardLayoutStore.getState().move("project", "runtime", "files", false, ["files", "runtime"]);
  });
  const view = render(<><Dashboard /><WorkspaceWidgetManager open onClose={() => {}} scope="project" /></>);
  const files = screen.getByRole("checkbox", { name: "Files" });
  await user.click(files);
  expect(view.container.querySelector('[data-dashboard-panel="files"]')).toBeNull();
  expect(screen.getByRole("checkbox", { name: "Files" })).toHaveAttribute("aria-checked", "false");
  expect(JSON.parse(localStorage.getItem(DASHBOARD_LAYOUT_KEY)!).project.hidden).toEqual(["files"]);
  expect(useDashboardLayoutStore.getState().layouts.other).toBeUndefined();
  await user.click(files);
  expect(view.container.querySelector('[data-dashboard-panel="files"]')).toHaveStyle({ height: "350px" });
  expect([...view.container.querySelectorAll<HTMLElement>('[data-dashboard-panel]')].map((el) => el.dataset.dashboardPanel)).toEqual(["runtime", "files"]);
  await user.click(screen.getByRole("button", { name: "Move up Files" }));
  expect(useDashboardLayoutStore.getState().layouts.project.order).toEqual(["files", "runtime"]);
});

it("keeps the library available when every widget is removed and supports remounting", () => {
  const view = render(<Dashboard />);
  act(() => {
    useDashboardLayoutStore.getState().setVisible("project", "files", false);
    useDashboardLayoutStore.getState().setVisible("project", "runtime", false);
  });
  expect(screen.getByText(/No widgets/)).toBeInTheDocument();
  expect(useDashboardLayoutStore.getState().catalogs.project).toHaveLength(2);
  view.unmount();
  const restored = render(<Dashboard />);
  expect(restored.container.querySelector('[data-dashboard-panel]')).toBeNull();
  act(() => useDashboardLayoutStore.getState().setVisible("project", "files", true));
  expect(screen.getByText("File content")).toBeInTheDocument();
});

it("restores hidden widgets on reload and migrates existing layouts without hiding cards", async () => {
  localStorage.setItem(DASHBOARD_LAYOUT_KEY, JSON.stringify({
    legacy: { order: ["files"], sizes: { files: { width: 1, height: 350 } } },
    project: { order: ["runtime", "files"], sizes: {}, hidden: ["files", "files", 42] },
  }));
  vi.resetModules();
  const restored = (await import("../state/dashboardLayoutStore")).useDashboardLayoutStore.getState();
  expect(restored.layouts.legacy.hidden).toEqual([]);
  expect(restored.layouts.legacy.sizes.files).toEqual({ width: 1, height: 350 });
  expect(restored.layouts.project.hidden).toEqual(["files"]);
  expect(restored.layouts.project.order).toEqual(["runtime", "files"]);
});
