import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolbarPill } from "../ToolbarPill";
import { loadMotion } from "../../../shared/design/motion";

const motion = vi.hoisted(() => ({ to: vi.fn(), killTweensOf: vi.fn() }));
vi.mock("../../../shared/design/motion", () => ({
  loadMotion: vi.fn(async () => motion),
  reducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
}));

const resizeObservers = new Set<() => void>();
const resize = () => { for (const callback of resizeObservers) callback(); };
const disconnect = vi.fn();
beforeEach(() => {
  resizeObservers.clear();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200);
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: (entries: ResizeObserverEntry[]) => void) { resizeObservers.add(this.notify); }
    private notify = () => this.callback([]);
    observe() {}
    unobserve() {}
    disconnect() { resizeObservers.delete(this.notify); disconnect(); }
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
    expect(slot.style.getPropertyValue("--toolbar-width")).toBe("0px");
    act(() => resize());
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

  it("slides its measured width with GSAP and retargets when closed", async () => {
    const { container, rerender } = render(<ToolbarPill visible>{content}</ToolbarPill>);
    await act(async () => resize());
    const slot = container.firstElementChild;
    expect(motion.to).toHaveBeenCalledWith(slot, expect.objectContaining({ width: 208, opacity: 1, x: 0, overwrite: true }));
    rerender(<ToolbarPill visible={false}>{content}</ToolbarPill>);
    await act(async () => {});
    expect(motion.to).toHaveBeenLastCalledWith(slot, expect.objectContaining({ width: 0, opacity: 0, x: -8 }));
  });

  it("cancels pending removal on rapid reopening", () => {
    const { rerender } = render(<ToolbarPill visible>{content}</ToolbarPill>);
    rerender(<ToolbarPill visible={false}>{content}</ToolbarPill>);
    act(() => vi.advanceTimersByTime(100));
    rerender(<ToolbarPill visible>{content}</ToolbarPill>);
    act(() => vi.advanceTimersByTime(280));
    expect(screen.getByRole("button", { name: "Wiki tools" })).toBeTruthy();
  });
  it("falls back to a usable static pill when GSAP cannot load", async () => {
    vi.mocked(loadMotion).mockRejectedValueOnce(new Error("Motion chunk unavailable"));
    const { container } = render(<ToolbarPill visible>{content}</ToolbarPill>);
    await act(async () => resize());
    const slot = container.firstElementChild as HTMLElement;
    expect(slot.style.width).toBe("");
    expect(slot.style.opacity).toBe("");
    expect(slot.style.transform).toBe("");
    expect(screen.getByRole("button", { name: "Wiki tools" })).toBeEnabled();
  });

});
