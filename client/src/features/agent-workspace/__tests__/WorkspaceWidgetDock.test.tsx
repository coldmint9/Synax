import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SessionSidePanel } from "../SessionSidePanel";
import { WorkspaceWidgetDock } from "../WorkspaceWidgetDock";
import { useDashboardLayoutStore } from "../state/dashboardLayoutStore";
import { WorkQuickActions } from "../WorkQuickActions";
import {
  SessionToolbarActionsTarget,
  SessionToolbarProvider,
} from "../SessionToolbarPortal";

vi.mock("../SessionWorkspacePanel", () => ({
  SessionWorkspacePanel: () => <div>Live widgets</div>,
}));
vi.mock("../../../shared/hooks/useLocale", () => ({
  useLocale: () => ({ locale: "en" }),
}));
afterEach(cleanup);

it("restores mounted card content from the header without keeping a bottom collapse button", () => {
  function Harness() {
    const [collapsed, setCollapsed] = useState(false);
    return (
      <SessionToolbarProvider>
        <header aria-label="Workspace toolbar">
          <SessionToolbarActionsTarget />
        </header>
        <WorkQuickActions
          expanded={!collapsed}
          onToggle={() => setCollapsed(!collapsed)}
          controlsId="widgets"
        />
        <SessionSidePanel
          id="widgets"
          activeViewId={collapsed ? null : "widgets"}
          views={[
            {
              id: "widgets",
              label: "Work widgets",
              width: 360,
              onResize: () => {},
              onResizeKeyDown: () => {},
              content: (
                <WorkspaceWidgetDock sessionId="session" scope="project" />
              ),
            },
          ]}
          minWidth={240}
          maxWidth={960}
        />
      </SessionToolbarProvider>
    );
  }
  const view = render(<Harness />);
  const content = screen.getByText("Live widgets");
  expect(view.container.querySelector("aside")).toHaveStyle({ width: "360px" });
  fireEvent.click(
    screen.getByRole("button", { name: "Collapse work widgets" }),
  );
  expect(view.container.querySelector("aside")).not.toBeVisible();
  expect(content).not.toBeVisible();
  expect(view.container.querySelector('[role="separator"]')).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Rearrange widgets" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Expand work widgets" }));
  expect(view.container.querySelector("aside")).toHaveStyle({ width: "360px" });
  expect(screen.getByText("Live widgets")).toBe(content);
  expect(content).toBeVisible();
  expect(
    within(screen.getByRole("toolbar")).getByRole("button", {
      name: "Rearrange widgets",
    }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Collapse work widgets" }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(
    within(screen.getByRole("toolbar")).queryByRole("button", {
      name: "Collapse work widgets",
    }),
  ).not.toBeInTheDocument();
  expect(
    within(screen.getByRole("banner")).getByRole("button", {
      name: "Collapse work widgets",
    }),
  ).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("opens project widget management from the bottom-right action and closes it", async () => {
  const user = userEvent.setup();
  useDashboardLayoutStore.setState({
    layouts: {},
    catalogs: { project: [{ id: "files", label: "Files" }] },
  });
  render(<WorkspaceWidgetDock sessionId="session" scope="project" />);
  const toolbar = screen.getByRole("toolbar");
  const rearrange = within(toolbar).getByRole("button", {
    name: "Rearrange widgets",
  });
  expect(toolbar.lastElementChild).toBe(rearrange);
  await user.click(rearrange);
  const dialog = await screen.findByRole("dialog", {
    name: "Rearrange widgets",
  });
  expect(
    within(dialog).getByRole("checkbox", { name: "Files" }),
  ).toHaveAttribute("aria-checked", "true");
  await user.click(within(dialog).getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
