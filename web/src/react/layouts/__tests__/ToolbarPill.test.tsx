import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolbarPill } from "../ToolbarPill";

let resize: () => void;
const disconnect = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect = disconnect;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const content = <button>Wiki tools</button>;
describe("ToolbarPill", () => {
  it("measures natural width, updates after resize and disconnects on unmount", () => {
    const { container, unmount } = render(<ToolbarPill visible>{content}</ToolbarPill>);
    const slot = container.firstElementChild as HTMLElement;
    expect(slot.style.getPropertyValue("--toolbar-width")).toBe("200px");
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(280);
    act(() => resize());
    expect(slot.style.getPropertyValue("--toolbar-width")).toBe("280px");
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it("keeps the slot for retraction, disables hidden controls immediately, then unmounts content", () => {
    const { container, rerender } = render(<ToolbarPill visible>{content}</ToolbarPill>);
    const slot = container.firstElementChild;
    rerender(<ToolbarPill visible={false}>{content}</ToolbarPill>);
    expect(container.firstElementChild).toBe(slot);
    expect(slot).toHaveClass("closing");
    expect(slot).toHaveAttribute("inert");
    expect(screen.queryByRole("button")).toBeNull();
    expect(slot?.querySelector("button")).not.toBeNull();
    act(() => vi.advanceTimersByTime(280));
    expect(slot?.querySelector("button")).toBeNull();
    rerender(<ToolbarPill visible>{content}</ToolbarPill>);
    expect(screen.getByRole("button", { name: "Wiki tools" })).toBeTruthy();
    expect(slot).not.toHaveAttribute("inert");
  });

  it("cancels pending removal on rapid reopening", () => {
    const { rerender } = render(<ToolbarPill visible>{content}</ToolbarPill>);
    rerender(<ToolbarPill visible={false}>{content}</ToolbarPill>);
    act(() => vi.advanceTimersByTime(100));
    rerender(<ToolbarPill visible>{content}</ToolbarPill>);
    act(() => vi.advanceTimersByTime(280));
    expect(screen.getByRole("button", { name: "Wiki tools" })).toBeTruthy();
  });
});
