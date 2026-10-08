import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceWidgetDock } from "../WorkspaceWidgetDock";
import { useDashboardLayoutStore } from "../state/dashboardLayoutStore";

vi.mock("../SessionWorkspacePanel", () => ({ SessionWorkspacePanel: () => <div>Live widgets</div> }));
vi.mock("../../../shared/hooks/useLocale", () => ({ useLocale: () => ({ locale: "en" }) }));
afterEach(cleanup);

it("retains the fixed action rail and restores width and mounted content after expanding", () => {
  function Harness() {
    const [collapsed, setCollapsed] = useState(false);
    return <WorkspaceWidgetDock sessionId="session" scope="project" width={360} collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} onResize={() => {}} />;
  }
  const view = render(<Harness />);
  const content = screen.getByText("Live widgets");
  expect(view.container.querySelector("aside")).toHaveStyle({ width: "360px" });
  fireEvent.click(screen.getByRole("button", { name: "Collapse work widgets" }));
  expect(view.container.querySelector("aside")).toHaveStyle({ width: "40px" });
  expect(screen.getByRole("toolbar")).toBeVisible();
  expect(content).not.toBeVisible();
  const viewport = view.container.querySelector(".work-widget-content");
  expect(viewport).not.toHaveAttribute("hidden");
  expect(viewport).toHaveAttribute("aria-hidden", "true");
  expect(viewport).toHaveAttribute("inert");
  expect(view.container.querySelector('[role="separator"]')).toBeNull();
  expect(screen.queryByRole("button", { name: "Rearrange widgets" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Expand work widgets" }));
  expect(view.container.querySelector("aside")).toHaveStyle({ width: "360px" });
  expect(screen.getByText("Live widgets")).toBe(content);
  expect(content).toBeVisible();
  expect(viewport).not.toHaveAttribute("inert");
  expect(within(screen.getByRole("toolbar")).getByRole("button", { name: "Rearrange widgets" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Collapse work widgets" })).toHaveAttribute("aria-expanded", "true");
});

it("opens project widget management from the bottom-right action and closes it", async () => {
  const user = userEvent.setup();
  useDashboardLayoutStore.setState({ layouts: {}, catalogs: { project: [{ id: "files", label: "Files" }] } });
  render(<WorkspaceWidgetDock sessionId="session" scope="project" width={360} collapsed={false} onToggle={() => {}} onResize={() => {}} />);
  const toolbar = screen.getByRole("toolbar");
  const rearrange = within(toolbar).getByRole("button", { name: "Rearrange widgets" });
  expect(toolbar.lastElementChild).toBe(rearrange);
  await user.click(rearrange);
  const dialog = await screen.findByRole("dialog", { name: "Rearrange widgets" });
  expect(within(dialog).getByRole("checkbox", { name: "Files" })).toHaveAttribute("aria-checked", "true");
  await user.click(within(dialog).getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
