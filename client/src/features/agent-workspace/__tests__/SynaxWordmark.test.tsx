import { act, fireEvent, render, screen } from "@testing-library/react";
import { gsap } from "gsap";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMotion } from "../../../shared/design/motion";
import { SynaxWordmark } from "../SynaxWordmark";

vi.mock("../../../shared/design/motion", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../shared/design/motion")>(),
  loadMotion: vi.fn(),
}));

let reduced = false;
let visibilityHidden = false;
let motionChanged: (() => void) | undefined;
let tweenSpy: ReturnType<typeof vi.spyOn<typeof gsap, "to">>;
const flush = () => act(async () => { await Promise.resolve(); });
const tween = () => tweenSpy.mock.results.at(-1)!.value as gsap.core.Tween;

beforeEach(() => {
  reduced = false;
  visibilityHidden = false;
  motionChanged = undefined;
  vi.mocked(loadMotion).mockReset().mockResolvedValue(gsap);
  tweenSpy = vi.spyOn(gsap, "to");
  vi.spyOn(document, "hidden", "get").mockImplementation(() => visibilityHidden);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    get matches() { return reduced; },
    media: query,
    addEventListener: vi.fn((_event, callback) => { motionChanged = callback as () => void; }),
    removeEventListener: vi.fn(),
  }) as unknown as MediaQueryList);
});
afterEach(() => vi.restoreAllMocks());

describe("block wordmark glow", () => {
  it("renders one seven-row block artwork without playback controls or pixel icons", () => {
    render(<SynaxWordmark animate={false} />);
    const mark = screen.getByRole("img", { name: "Synax" });
    expect(mark.querySelectorAll("pre")).toHaveLength(1);
    const art = mark.querySelector("pre")!;
    expect(art).toHaveAttribute("data-ascii-style", "blocks");
    expect(art.textContent).toMatch(/^[█ \n]+$/);
    const rows = art.textContent!.split("\n");
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((row) => row.length)).size).toBe(1);
    expect(art).toHaveAttribute("data-ascii-art", art.textContent);
    expect(mark.querySelector("svg")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("breathes the glow without changing the artwork, text opacity, or geometry", async () => {
    const { container } = render(<SynaxWordmark />);
    await flush();
    const glow = tween().pause();
    const frame = container.querySelector<HTMLElement>("pre")!;
    const originalText = frame.textContent;
    expect(glow.duration()).toBe(2.8);
    expect(glow.repeat()).toBe(-1);
    expect(glow.yoyo()).toBe(true);
    glow.totalTime(2.8);
    expect(Number(frame.style.getPropertyValue("--synax-glow-opacity"))).toBeCloseTo(.85);
    glow.totalTime(5.6);
    expect(Number(frame.style.getPropertyValue("--synax-glow-opacity"))).toBeCloseTo(.28);
    expect(frame.textContent).toBe(originalText);
    expect(frame.style.opacity).toBe("");
    expect(frame.style.transform).toBe("");
  });

  it("pauses in a hidden tab and resumes when visible", async () => {
    render(<SynaxWordmark />);
    await flush();
    const glow = tween();
    expect(glow.paused()).toBe(false);
    visibilityHidden = true;
    fireEvent(document, new Event("visibilitychange"));
    expect(glow.paused()).toBe(true);
    visibilityHidden = false;
    fireEvent(document, new Event("visibilitychange"));
    expect(glow.paused()).toBe(false);
  });

  it("does not load GSAP for compact, explicitly static, or reduced-motion marks", async () => {
    const { rerender } = render(<SynaxWordmark compact />);
    expect(screen.getByRole("img", { name: "Synax" }).querySelectorAll("pre")).toHaveLength(1);
    rerender(<SynaxWordmark animate={false} />);
    reduced = true;
    rerender(<SynaxWordmark />);
    await flush();
    expect(loadMotion).not.toHaveBeenCalled();
  });

  it("restores static glow on live reduced-motion changes and can resume", async () => {
    const { container } = render(<SynaxWordmark />);
    await flush();
    const oldGlow = tween();
    oldGlow.pause().totalTime(30);
    reduced = true;
    act(() => motionChanged?.());
    expect(oldGlow.parent).toBeNull();
    expect(container.querySelector<HTMLElement>("pre")!.style.getPropertyValue("--synax-glow-opacity")).toBe("");
    reduced = false;
    act(() => motionChanged?.());
    await flush();
    expect(tween()).not.toBe(oldGlow);
    expect(tween().paused()).toBe(false);
  });

  it("reverts the tween and removes visibility listeners when unmounted", async () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(<SynaxWordmark />);
    await flush();
    const glow = tween();
    unmount();
    expect(glow.parent).toBeNull();
    expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });

  it("does not create animation if the lazy import resolves after unmount", async () => {
    let resolve!: (engine: typeof gsap) => void;
    vi.mocked(loadMotion).mockReturnValue(new Promise((done) => { resolve = done; }));
    const { unmount } = render(<SynaxWordmark />);
    unmount();
    await act(async () => { resolve(gsap); });
    expect(tweenSpy).not.toHaveBeenCalled();
  });

  it("ignores a stale import when motion preferences change during loading", async () => {
    let resolve!: (engine: typeof gsap) => void;
    vi.mocked(loadMotion).mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<SynaxWordmark />);
    reduced = true;
    act(() => motionChanged?.());
    reduced = false;
    act(() => motionChanged?.());
    await act(async () => { resolve(gsap); });
    expect(tweenSpy).toHaveBeenCalledTimes(1);
  });

  it("retains static artwork when the lazy import fails", async () => {
    vi.mocked(loadMotion).mockRejectedValue(new Error("offline"));
    render(<SynaxWordmark />);
    await flush();
    expect(screen.getByRole("img", { name: "Synax" }).querySelector("pre")).toHaveTextContent("██");
    expect(tweenSpy).not.toHaveBeenCalled();
  });
});
