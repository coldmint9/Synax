// @vitest-environment jsdom
import { StrictMode, useEffect, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkbenchIsland,
  WorkbenchIslandProvider,
  WorkbenchIslandSlot,
} from "../WorkbenchIsland";


const motion = vi.hoisted(() => ({ kill: vi.fn(), fromTo: vi.fn() }));
vi.mock("../../../shared/design/motion", () => ({
  loadMotion: async () => ({ fromTo: motion.fromTo.mockImplementation(() => ({ kill: motion.kill })) }),
  reducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
}));
const mounted = vi.fn();
function Controls({ compact }: { compact: boolean }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    mounted();
  }, []);
  return (
    <div className="wh-pill" data-compact={compact}>
      <button onClick={() => setCount(count + 1)}>Menu {count}</button>
      <input aria-label="Island search" defaultValue="Search draft" />
    </div>
  );
}
function Workbench({
  viewer = false,
  active = true,
}: {
  viewer?: boolean;
  active?: boolean;
}) {
  return (
    <WorkbenchIslandProvider>
      <WorkbenchIsland
        placement={active ? (viewer ? "viewer" : "conversation") : "global"}
      >
        {(compact) => <Controls compact={compact} />}
      </WorkbenchIsland>
      <main>
        <button>Outside the island</button>
        <WorkbenchIslandSlot placement="conversation" />
        {viewer && (
          <header>
            <WorkbenchIslandSlot placement="viewer" />
          </header>
        )}
      </main>
    </WorkbenchIslandProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("WorkbenchIsland", () => {
  it("moves the same controls into the viewer and back without losing menu state", () => {
    mounted.mockClear();
    const { container, rerender, unmount } = render(<Workbench />);
    const button = screen.getByRole("button", { name: "Menu 0" });
    fireEvent.click(button);
    const pill = button.parentElement!;
    expect(
      container.querySelector(".workspace-island-slot--conversation .wh-pill"),
    ).toBe(pill);
    rerender(<Workbench viewer />);
    expect(container.querySelector("header .wh-pill")).toBe(pill);
    expect(pill).toHaveAttribute("data-compact", "true");
    rerender(<Workbench />);
    expect(
      container.querySelector(".workspace-island-slot--conversation .wh-pill"),
    ).toBe(pill);
    expect(pill).toHaveAttribute("data-compact", "false");
    rerender(<Workbench viewer />);
    expect(screen.getByRole("button", { name: "Menu 1" })).toBe(button);
    expect(mounted).toHaveBeenCalledTimes(1);
    unmount();
    expect(pill.isConnected).toBe(false);
  });

  it("restores the actual focused descendant with preventScroll in both directions", () => {
    const { rerender } = render(<Workbench />);
    const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Island search" });
    input.focus();
    input.setSelectionRange(1, 4, "backward");
    const focus = vi.spyOn(input, "focus");
    const menuFocus = vi.spyOn(screen.getByRole("button", { name: "Menu 0" }), "focus");
    for (const viewer of [true, false]) {
      rerender(<Workbench viewer={viewer} />);
      expect(screen.getByRole("textbox", { name: "Island search" })).toBe(input);
      expect(input).toHaveFocus();
      expect(input).toHaveValue("Search draft");
      expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([1, 4, "backward"]);
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      focus.mockClear();
    }
    expect(menuFocus).not.toHaveBeenCalled();
  });

  it("never steals unrelated focus when the island is reparented", () => {
    const { rerender } = render(<Workbench />);
    const button = screen.getByRole("button", { name: "Menu 0" });
    const outside = screen.getByRole("button", { name: "Outside the island" });
    button.focus();
    outside.focus();
    const focus = vi.spyOn(button, "focus");
    rerender(<Workbench viewer />);
    expect(outside).toHaveFocus();
    rerender(<Workbench />);
    expect(outside).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
  });

  it("takes the header out of an inactive cached viewer on another route", () => {
    const { container, rerender } = render(<Workbench viewer />);
    const button = screen.getByRole("button", { name: "Menu 0" });
    rerender(<Workbench viewer active={false} />);
    expect(container.querySelector("header .wh-pill")).toBeNull();
    expect(container.querySelector(".workbench-island-anchor button")).toBe(
      button,
    );
    rerender(<Workbench viewer />);
    expect(container.querySelector("header button")).toBe(button);
  });

  it("survives StrictMode replay with only one mounted island", () => {
    const { container, rerender } = render(
      <StrictMode>
        <Workbench viewer />
      </StrictMode>,
    );
    expect(container.querySelector("header .wh-pill")).toBeInTheDocument();
    rerender(
      <StrictMode>
        <Workbench />
      </StrictMode>,
    );
    expect(
      container.querySelector(".workspace-island-slot--conversation .wh-pill"),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Menu 0" })).toHaveLength(1);
  });

  it("measures before labels collapse, animates only the island with GSAP, and honors reduced motion", async () => {
    motion.kill.mockClear();
    motion.fromTo.mockClear();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const compact = this.dataset.compact === "true";
        return {
          x: compact ? 280 : 500,
          y: 15,
          width: compact ? 150 : 300,
          height: compact ? 30 : 36,
          top: 15,
          left: compact ? 280 : 500,
          right: 800,
          bottom: 51,
          toJSON: () => ({}),
        };
      },
    );
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const { container, rerender } = render(<Workbench />);
    await act(async () => { rerender(<Workbench viewer />); });
    expect(motion.fromTo).toHaveBeenCalledWith(
      container.querySelector(".wh-pill"),
      expect.objectContaining({ x: 220, y: 0, scaleX: 2, scaleY: 1.2 }),
      expect.objectContaining({ x: 0, y: 0, duration: .24, clearProps: "transform,transformOrigin" }),
    );
    const cancelledBeforeUnchangedRender = motion.kill.mock.calls.length;
    rerender(<Workbench viewer />);
    expect(motion.kill).toHaveBeenCalledTimes(cancelledBeforeUnchangedRender);
    motion.fromTo.mockClear();
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    rerender(<Workbench />);
    expect(motion.fromTo).not.toHaveBeenCalled();
    expect(motion.kill).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
