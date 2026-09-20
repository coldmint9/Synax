import { StrictMode, useEffect, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  WorkbenchIsland,
  WorkbenchIslandProvider,
  WorkbenchIslandSlot,
} from "../WorkbenchIsland";

const mounts = vi.fn();
function Controls({ docked }: { docked: boolean }) {
  const [count, setCount] = useState(0);
  useEffect(() => { mounts(); }, []);
  return (
    <div className="wh-pill" data-docked={docked}>
      <button onClick={() => setCount(count + 1)}>Menu {count}</button>
    </div>
  );
}
function Workbench({ viewer, enabled = true }: { viewer: boolean; enabled?: boolean }) {
  return (
    <WorkbenchIslandProvider>
      <WorkbenchIsland enabled={enabled}>
        {(docked) => <Controls docked={docked} />}
      </WorkbenchIsland>
      {viewer && <header><WorkbenchIslandSlot /></header>}
    </WorkbenchIslandProvider>
  );
}

describe("WorkbenchIsland", () => {
  it("preserves the same controls and menu state through docking, returning and reopening", () => {
    mounts.mockClear();
    const { container, rerender, unmount } = render(<Workbench viewer={false} />);
    const control = screen.getByRole("button", { name: "Menu 0" });
    fireEvent.click(control);
    const pill = control.parentElement!;
    rerender(<Workbench viewer />);
    expect(container.querySelector("header .wh-pill")).toBe(pill);
    expect(pill).toHaveAttribute("data-docked", "true");
    expect(screen.getByRole("button", { name: "Menu 1" })).toBe(control);
    rerender(<Workbench viewer={false} />);
    expect(container.querySelector(".workbench-island-anchor .wh-pill")).toBe(pill);
    expect(pill).toHaveAttribute("data-docked", "false");
    rerender(<Workbench viewer />);
    expect(container.querySelector("header .wh-pill")).toBe(pill);
    expect(mounts).toHaveBeenCalledTimes(1);
    unmount();
    expect(pill.isConnected).toBe(false);
  });

  it("returns to the floating anchor while a cached viewer is inactive", () => {
    const { container, rerender } = render(<Workbench viewer />);
    const control = screen.getByRole("button", { name: "Menu 0" });
    rerender(<Workbench viewer enabled={false} />);
    expect(container.querySelector("header .wh-pill")).toBeNull();
    expect(container.querySelector(".workbench-island-anchor button")).toBe(control);
    rerender(<Workbench viewer />);
    expect(container.querySelector("header button")).toBe(control);
  });

  it("keeps the mount attached when effects replay in StrictMode", () => {
    const { container, rerender } = render(<StrictMode><Workbench viewer /></StrictMode>);
    expect(container.querySelector("header .wh-pill")).toBeInTheDocument();
    rerender(<StrictMode><Workbench viewer={false} /></StrictMode>);
    expect(container.querySelector(".workbench-island-anchor .wh-pill")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Menu 0" })).toHaveLength(1);
  });
});
