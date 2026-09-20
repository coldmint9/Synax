import { StrictMode, useEffect, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkbenchIsland,
  WorkbenchIslandProvider,
  WorkbenchIslandSlot,
} from "../WorkbenchIsland";

const mounted = vi.fn();
function Controls({ compact }: { compact: boolean }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    mounted();
  }, []);
  return (
    <div className="wh-pill" data-compact={compact}>
      <button onClick={() => setCount(count + 1)}>Menu {count}</button>
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

  it("measures before labels collapse, animates only the island, and honors reduced motion", () => {
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }) as unknown as Animation);
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
    container.querySelector<HTMLElement>(".wh-pill")!.animate = animate;
    rerender(<Workbench viewer />);
    expect(animate).toHaveBeenCalledWith(
      [
        { transform: "translate(220px, 0px) scale(2, 1.2)" },
        { transform: "none" },
      ],
      expect.objectContaining({ duration: 280 }),
    );
    rerender(<Workbench viewer />);
    expect(cancel).not.toHaveBeenCalled();
    animate.mockClear();
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    rerender(<Workbench />);
    expect(animate).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
