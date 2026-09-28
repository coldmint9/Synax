import { Profiler, StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { LiquidGlassSurface } from "./LiquidGlassSurface";
import * as runtimeModule from "./glass/runtime";
import { createGlassScheduler } from "./glass/scheduler";
import { createFrameClock, createMockGL } from "./glass/__tests__/helpers";
import { createGlassRenderer } from "./glass/renderer";
import type { RendererOptions, GlassRenderer, RendererResult } from "./glass/types";

class MediaQuery extends EventTarget {
  matches = false;
  constructor(readonly media: string) { super(); }
  change(value: boolean) { this.matches = value; this.dispatchEvent(new Event("change")); }
}

let clock: ReturnType<typeof createFrameClock>;
let media: Map<string, MediaQuery>;
let resizeObservers: Array<{ callback: ResizeObserverCallback; disconnect: Mock<() => void> }>;
let intersectionObservers: Array<{ callback: IntersectionObserverCallback; disconnect: Mock<() => void>; target?: Element }>;
let records: Array<{ renderer: GlassRenderer; options: RendererOptions; canvas: HTMLCanvasElement }>;
let loadRenderer: Mock<runtimeModule.GlassRuntime["loadRenderer"]>;
let factory: Mock<(canvas: HTMLCanvasElement, options?: RendererOptions) => RendererResult>;
let visibility: DocumentVisibilityState;

beforeEach(() => {
  clock = createFrameClock(); media = new Map(); records = []; resizeObservers = []; intersectionObservers = [];
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 48));
  vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    let value = media.get(query);
    if (!value) { value = new MediaQuery(query); media.set(query, value); }
    return value as unknown as MediaQueryList;
  });
  vi.stubGlobal("ResizeObserver", class {
    disconnect = vi.fn();
    constructor(callback: ResizeObserverCallback) { resizeObservers.push({ callback, disconnect: this.disconnect }); }
    observe() {}
  });
  vi.stubGlobal("IntersectionObserver", class {
    record: typeof intersectionObservers[number];
    constructor(callback: IntersectionObserverCallback) {
      this.record = { callback, disconnect: vi.fn() };
      intersectionObservers.push(this.record);
    }
    observe(target: Element) { this.record.target = target; }
    disconnect() { this.record.disconnect(); }
  });
  factory = vi.fn((canvas: HTMLCanvasElement, options: RendererOptions = {}): RendererResult => {
    const renderer = { draw: vi.fn(), resize: vi.fn(), dispose: vi.fn(() => true) };
    records.push({ renderer, canvas, options });
    return { ok: true, renderer };
  });
  loadRenderer = vi.fn(async () => ({ createGlassRenderer: factory }));
  vi.spyOn(runtimeModule, "getGlassRuntime").mockReturnValue({ scheduler: createGlassScheduler(clock), loadRenderer });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function intersect(visible = true, index?: number) {
  await act(async () => {
    for (const observer of index === undefined ? intersectionObservers : [intersectionObservers[index]]) {
      observer.callback([{ target: observer.target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
  });
}
function setMedia(query: string, value: boolean) {
  let list = media.get(query);
  if (!list) { list = new MediaQuery(query); media.set(query, list); }
  act(() => list.change(value));
}
function surface(container: HTMLElement) { return container.querySelector<HTMLElement>(".liquid-glass-surface")!; }
function flush(time: number) { act(() => clock.flush(time)); }

describe("LiquidGlassSurface", () => {
  it("keeps flat surfaces free of optical layers and GPU work, including after interaction", async () => {
    const click = vi.fn();
    const view = render(<LiquidGlassSurface finish="flat"><button onClick={click}>Flat action</button></LiquidGlassSurface>);
    await intersect();
    fireEvent.pointerEnter(surface(view.container));
    fireEvent.pointerMove(surface(view.container), { clientX: 120, clientY: 12 });
    fireEvent.click(screen.getByText("Flat action"));
    flush(32);
    expect(click).toHaveBeenCalledOnce();
    expect(surface(view.container)).toHaveAttribute("data-glass-finish", "flat");
    expect(view.container.querySelector("svg")).toBeNull();
    expect(view.container.querySelector("canvas")).toBeNull();
    expect(loadRenderer).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
    setMedia("(prefers-reduced-transparency: reduce)", true);
    expect(surface(view.container)).toHaveAttribute("data-glass-reason", "reduced-transparency");
  });

  it("keeps a separate rounded shoulder in the static fallback without filtering content", async () => {
    setMedia("(prefers-reduced-motion: reduce)", true);
    const view = render(<><LiquidGlassSurface>A</LiquidGlassSurface><LiquidGlassSurface>B</LiquidGlassSurface></>);
    await intersect();
    const roots = view.container.querySelectorAll(".liquid-glass-surface");
    const masks = new Set<string>();
    for (const root of roots) {
      const shoulder = root.querySelector("svg > rect[data-glass-shoulder]");
      expect(shoulder).not.toBeNull();
      expect(shoulder).not.toHaveAttribute("filter");
      const mask = shoulder!.getAttribute("mask")!;
      expect(mask).toMatch(/^url\(#.+-shoulder-mask\)$/);
      masks.add(mask);
      const inner = root.querySelector(".liquid-glass-shoulder-inner");
      expect(inner).toHaveAttribute("fill", "black");
      expect(root.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(root.querySelector(".liquid-glass-content")).not.toHaveAttribute("filter");
    }
    expect(masks.size).toBe(2);
    expect(factory).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });

  it("draws a real filtered and masked SVG rim; content has no filter or extra layout box", async () => {
    setMedia("(prefers-reduced-motion: reduce)", true);
    const click = vi.fn();
    const view = render(<LiquidGlassSurface className="flex gap-2" intensity="strong"><button onClick={click}>Action</button><span>Label</span></LiquidGlassSurface>);
    await intersect();
    const root = surface(view.container);
    expect(root).toHaveClass("flex", "gap-2", "liquid-glass-surface--strong");
    expect(root).toHaveAttribute("data-glass-state", "fallback");
    expect(root).toHaveAttribute("data-glass-reason", "reduced-motion");
    const rim = root.querySelector("svg > rect[data-glass-rim]");
    expect(rim).toHaveAttribute("filter", expect.stringMatching(/^url\(#.+\)$/));
    expect(rim).toHaveAttribute("mask", expect.stringMatching(/^url\(#.+\)$/));
    const content = root.querySelector<HTMLElement>(".liquid-glass-content")!;
    expect(content.style.display).toBe("contents");
    expect(content).not.toHaveAttribute("filter");
    expect(content.querySelector("canvas, svg")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Action" }));
    expect(click).toHaveBeenCalledOnce();
    expect(loadRenderer).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });

  it("lazily acquires only visible surfaces, coalesces pointer input, reads its latest value, then idles", async () => {
    const view = render(<LiquidGlassSurface>Tools</LiquidGlassSurface>);
    expect(loadRenderer).not.toHaveBeenCalled();
    await intersect();
    expect(factory).toHaveBeenCalledOnce();
    expect(surface(view.container)).toHaveAttribute("data-glass-state", "gpu");
    flush(16);
    expect(clock.pending()).toBe(0);
    fireEvent.pointerMove(surface(view.container), { clientX: 30, clientY: 12 });
    fireEvent.pointerMove(surface(view.container), { clientX: 270, clientY: 36 });
    expect(clock.pending()).toBe(1);
    flush(250);
    expect(records[0].renderer.draw).toHaveBeenLastCalledWith(expect.objectContaining({ pointer: { x: 0.9, y: 0.75 } }));
    expect(clock.pending()).toBe(0);
    expect(factory).toHaveBeenCalledOnce();
    flush(1000);
    expect(clock.pending()).toBe(0);
  });

  it("resizes through ResizeObserver without rebuilding and cleans observers, listeners, RAF and renderer", async () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const view = render(<LiquidGlassSurface>Tools</LiquidGlassSurface>);
    await intersect();
    const renderer = records[0].renderer;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 900, 80));
    act(() => resizeObservers[0].callback([], {} as ResizeObserver));
    expect(renderer.resize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 900, height: 80 }));
    expect(factory).toHaveBeenCalledOnce();
    view.unmount();
    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(resizeObservers[0].disconnect).toHaveBeenCalledOnce();
    expect(intersectionObservers[0].disconnect).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(clock.pending()).toBe(0);
    const loads = loadRenderer.mock.calls.length;
    setMedia("(prefers-reduced-motion: reduce)", true);
    expect(loadRenderer).toHaveBeenCalledTimes(loads);
  });

  it("stops offscreen and hidden work and resumes with a single fresh frame", async () => {
    const view = render(<LiquidGlassSurface>Tools</LiquidGlassSurface>);
    await intersect();
    await intersect(false);
    expect(records[0].renderer.dispose).toHaveBeenCalledOnce();
    expect(clock.pending()).toBe(0);
    expect(surface(view.container)).toHaveAttribute("data-glass-reason", "offscreen");
    await intersect();
    expect(factory).toHaveBeenCalledTimes(2);
    await act(async () => { visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange")); });
    expect(clock.pending()).toBe(0);
    expect(records[1].renderer.dispose).toHaveBeenCalledOnce();
    expect(surface(view.container)).toHaveAttribute("data-glass-reason", "hidden");
    await act(async () => { visibility = "visible"; document.dispatchEvent(new Event("visibilitychange")); });
    flush(16);
    expect(factory).toHaveBeenCalledTimes(3);
    expect(clock.pending()).toBe(0);
  });

  it.each([
    ["(prefers-reduced-motion: reduce)", "reduced-motion"],
    ["(prefers-reduced-transparency: reduce)", "reduced-transparency"],
    ["(forced-colors: active)", "high-contrast"],
    ["(prefers-contrast: more)", "high-contrast"],
  ])("reacts to live %s preferences without GPU animation", async (query, reason) => {
    const view = render(<LiquidGlassSurface>Tools</LiquidGlassSurface>);
    await intersect();
    setMedia(query, true);
    expect(records[0].renderer.dispose).toHaveBeenCalledOnce();
    expect(surface(view.container)).toHaveAttribute("data-glass-reason", reason);
    expect(clock.pending()).toBe(0);
    fireEvent.pointerMove(surface(view.container), { clientX: 200, clientY: 20 });
    expect(clock.pending()).toBe(0);
    await act(async () => setMedia(query, false));
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("defaults controls to CSS/SVG and enforces the shared two-context budget with island priority", async () => {
    const view = render(<><button><LiquidGlassSurface>Control</LiquidGlassSurface></button><LiquidGlassSurface>Island A</LiquidGlassSurface><LiquidGlassSurface>Island B</LiquidGlassSurface><LiquidGlassSurface>Island C</LiquidGlassSurface></>);
    await intersect(true, 0);
    expect(factory).not.toHaveBeenCalled();
    const control = surface(view.container);
    await act(async () => fireEvent.pointerEnter(control));
    expect(factory).toHaveBeenCalledOnce();
    await intersect(true, 1);
    await intersect(true, 2);
    await intersect(true, 3);
    const live = records.filter((record) => !vi.mocked(record.renderer.dispose).mock.calls.length);
    expect(live).toHaveLength(2);
    expect(records[0].renderer.dispose).toHaveBeenCalledOnce();
    expect(view.container.querySelectorAll("canvas")).toHaveLength(2);
    expect(control).toHaveAttribute("data-glass-reason", "budget");
  });

  it("leaves clicks and keyboard content working on explicit renderer or lazy import failure; never retries on pointer input", async () => {
    factory.mockReturnValue({ ok: false, reason: "webgl-unavailable", contextReleased: true });
    const click = vi.fn();
    const view = render(<LiquidGlassSurface><button onClick={click}>Fallback</button></LiquidGlassSurface>);
    await intersect();
    expect(surface(view.container)).toHaveAttribute("data-glass-reason", "webgl-unavailable");
    fireEvent.pointerMove(surface(view.container), { clientX: 100, clientY: 20 });
    fireEvent.click(screen.getByRole("button", { name: "Fallback" }));
    screen.getByRole("button").focus();
    expect(screen.getByRole("button")).toHaveFocus();
    expect(click).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
    expect(view.container.querySelector("canvas")).toBeNull();
    expect(clock.pending()).toBe(0);
    view.unmount();
    loadRenderer.mockRejectedValue(new Error("chunk unavailable"));
    const failed = render(<LiquidGlassSurface>Still here</LiquidGlassSurface>);
    await intersect(true, 1);
    expect(surface(failed.container)).toHaveAttribute("data-glass-reason", "load-error");
    expect(screen.getByText("Still here")).toBeVisible();
  });

  it("cancels on context loss, requests exactly one frame on restoration and disposes on restoration failure", async () => {
    const view = render(<LiquidGlassSurface>Tools</LiquidGlassSurface>);
    await intersect();
    act(() => records[0].options.onStatusChange?.("context-lost"));
    expect(surface(view.container)).toHaveAttribute("data-glass-reason", "context-lost");
    expect(clock.pending()).toBe(0);
    fireEvent.pointerMove(surface(view.container), { clientX: 200, clientY: 10 });
    expect(clock.pending()).toBe(0);
    act(() => records[0].options.onStatusChange?.("ready"));
    expect(clock.pending()).toBe(1);
    flush(250);
    expect(clock.pending()).toBe(0);
    act(() => records[0].options.onStatusChange?.("program-link"));
    expect(records[0].renderer.dispose).toHaveBeenCalledOnce();
    expect(surface(view.container)).toHaveAttribute("data-glass-reason", "program-link");
  });

  it("does not create a context after a delayed import is invalidated or unmounted in StrictMode", async () => {
    let resolve!: (module: Awaited<ReturnType<runtimeModule.GlassRuntime["loadRenderer"]>>) => void;
    loadRenderer.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const view = render(<StrictMode><LiquidGlassSurface>Tools</LiquidGlassSurface></StrictMode>);
    await intersect(true, intersectionObservers.length - 1);
    view.unmount();
    await act(async () => resolve({ createGlassRenderer: factory }));
    expect(factory).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
    for (const observer of resizeObservers) expect(observer.disconnect).toHaveBeenCalledOnce();
    for (const observer of intersectionObservers) expect(observer.disconnect).toHaveBeenCalledOnce();
  });

  it("does not commit React renders for pointer frames", async () => {
    const commits = vi.fn();
    const view = render(<Profiler id="glass" onRender={commits}><LiquidGlassSurface>Tools</LiquidGlassSurface></Profiler>);
    await intersect(); flush(16);
    const initialCommits = commits.mock.calls.length;
    for (let i = 0; i < 10; i++) fireEvent.pointerMove(surface(view.container), { clientX: 20 * i, clientY: 20 });
    flush(32); flush(64); flush(250);
    expect(commits).toHaveBeenCalledTimes(initialCommits);
    expect(clock.pending()).toBe(0);
  });

  it("gives keyboard-focused controls only spare contexts and returns them on blur", async () => {
    const view = render(<><button><LiquidGlassSurface>Control</LiquidGlassSurface></button><button>Outside</button></>);
    await intersect();
    expect(factory).not.toHaveBeenCalled();
    await act(async () => screen.getByRole("button", { name: "Control" }).focus());
    expect(factory).toHaveBeenCalledOnce();
    expect(surface(view.container)).toHaveAttribute("data-glass-state", "gpu");
    act(() => screen.getByRole("button", { name: "Outside" }).focus());
    expect(records[0].renderer.dispose).toHaveBeenCalledOnce();
    expect(surface(view.container)).toHaveAttribute("data-glass-reason", "static");
    expect(clock.pending()).toBe(0);
  });

  it("invalidates an in-flight import immediately when preferences change", async () => {
    let resolve!: (module: Awaited<ReturnType<runtimeModule.GlassRuntime["loadRenderer"]>>) => void;
    loadRenderer.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const view = render(<LiquidGlassSurface>Tools</LiquidGlassSurface>);
    await intersect();
    expect(surface(view.container)).toHaveAttribute("data-glass-state", "loading");
    setMedia("(prefers-reduced-motion: reduce)", true);
    await act(async () => resolve({ createGlassRenderer: factory }));
    expect(factory).not.toHaveBeenCalled();
    expect(surface(view.container)).toHaveAttribute("data-glass-reason", "reduced-motion");
    expect(clock.pending()).toBe(0);
  });

  it("removes every media/pointer/focus listener and disconnects theme observation in StrictMode", async () => {
    const removeElementListener = vi.spyOn(HTMLElement.prototype, "removeEventListener");
    const disconnectTheme = vi.spyOn(MutationObserver.prototype, "disconnect");
    const view = render(<StrictMode><LiquidGlassSurface>Tools</LiquidGlassSurface></StrictMode>);
    await intersect(true, intersectionObservers.length - 1);
    const removeMediaListeners = [...media.values()].map((query) => vi.spyOn(query, "removeEventListener"));
    view.unmount();
    for (const name of ["pointerenter", "pointerleave", "pointermove", "focusin", "focusout"]) {
      expect(removeElementListener).toHaveBeenCalledWith(name, expect.any(Function));
    }
    for (const remove of removeMediaListeners) expect(remove).toHaveBeenCalledWith("change", expect.any(Function));
    expect(disconnectTheme).toHaveBeenCalledTimes(2);
    expect(records).toHaveLength(1);
    expect(records[0].renderer.dispose).toHaveBeenCalledOnce();
    expect(clock.pending()).toBe(0);
  });

  it("tracks root theme changes when a portal host is attached after the surface effect", async () => {
    const host = document.createElement("div");
    const view = render(<LiquidGlassSurface>Portal island</LiquidGlassSurface>, { container: host });
    try {
      document.body.append(host);
      await intersect(); flush(16);
      await act(async () => { document.documentElement.classList.add("dark"); });
      flush(32);
      expect(surface(host)).toHaveAttribute("data-glass-theme", "dark");
      expect(records[0].renderer.draw).toHaveBeenLastCalledWith(expect.objectContaining({ dark: true }));
      expect(clock.pending()).toBe(0);
      await act(async () => { document.documentElement.classList.remove("dark"); });
      flush(48);
      expect(surface(host)).toHaveAttribute("data-glass-theme", "light");
      expect(records[0].renderer.draw).toHaveBeenLastCalledWith(expect.objectContaining({ dark: false }));
      expect(clock.pending()).toBe(0);
    } finally {
      view.unmount();
      host.remove();
      document.documentElement.classList.remove("dark");
    }
  });

  it("ignores ancestor motion styles but still reacts to theme variables", async () => {
    const view = render(<div data-motion-host=""><LiquidGlassSurface>Tools</LiquidGlassSurface></div>);
    await intersect(); flush(16);
    const host = view.container.querySelector<HTMLElement>("[data-motion-host]")!;
    const renderer = records[0].renderer;
    renderer.resize.mockClear();
    for (let frame = 1; frame <= 6; frame++) {
      await act(async () => {
        host.style.transform = `translateX(${frame}px)`;
        host.style.width = `${100 + frame}px`;
        host.style.opacity = `${frame / 10}`;
      });
    }
    expect(renderer.resize).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
    await act(async () => { host.style.setProperty("--ui-panel", "#222"); });
    expect(renderer.resize).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(1);
  });

  it("honors interactive=false and redraws theme changes without polling", async () => {
    const view = render(<LiquidGlassSurface interactive={false}>Tools</LiquidGlassSurface>);
    await intersect(); flush(16);
    fireEvent.pointerMove(surface(view.container), { clientX: 200, clientY: 20 });
    expect(clock.pending()).toBe(0);
    await act(async () => { document.documentElement.classList.add("dark"); });
    flush(32);
    expect(records[0].renderer.draw).toHaveBeenLastCalledWith(expect.objectContaining({ dark: true }));
    expect(clock.pending()).toBe(0);
    await act(async () => { document.documentElement.classList.remove("dark"); });
  });

  it("uses the final matching intersection record, including when another target follows it", async () => {
    const view = render(<LiquidGlassSurface>Tools</LiquidGlassSurface>);
    await intersect();
    const observer = intersectionObservers[0];
    const entry = (isIntersecting: boolean, target = observer.target) => ({
      target, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0,
    } as IntersectionObserverEntry);
    await act(async () => observer.callback([
      entry(true), entry(false), entry(true, document.createElement("div")),
    ], {} as IntersectionObserver));
    expect(records[0].renderer.dispose).toHaveBeenCalledOnce();
    expect(surface(view.container)).toHaveAttribute("data-glass-reason", "offscreen");
    expect(clock.pending()).toBe(0);
    await act(async () => observer.callback([entry(false), entry(true)], {} as IntersectionObserver));
    expect(factory).toHaveBeenCalledTimes(2);
    expect(surface(view.container)).toHaveAttribute("data-glass-state", "gpu");
  });

  it("accepts an edge-adjacent isIntersecting=true record at the default zero threshold", async () => {
    const view = render(<LiquidGlassSurface>Tools</LiquidGlassSurface>);
    const observer = intersectionObservers[0];
    await act(async () => observer.callback([{
      target: observer.target, isIntersecting: true, intersectionRatio: 0,
    } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(factory).toHaveBeenCalledOnce();
    expect(surface(view.container)).toHaveAttribute("data-glass-state", "gpu");
    flush(16);
    expect(clock.pending()).toBe(0);
  });

  it("snaps the latest pointer on acquisition when pointer moves arrived BEFORE the renderer was ready", async () => {
    let resolve!: (module: Awaited<ReturnType<runtimeModule.GlassRuntime["loadRenderer"]>>) => void;
    loadRenderer.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const view = render(<LiquidGlassSurface>Tools</LiquidGlassSurface>);
    await intersect();
    flush(24);
    fireEvent.pointerMove(surface(view.container), { clientX: 30, clientY: 12 });
    fireEvent.pointerMove(surface(view.container), { clientX: 270, clientY: 36 });
    expect(clock.pending()).toBe(0);
    await act(async () => resolve({ createGlassRenderer: factory }));
    flush(48); // Ready only 24ms after input: do not strand an intermediate point.
    expect(records[0].renderer.draw).toHaveBeenLastCalledWith(expect.objectContaining({ pointer: { x: 0.9, y: 0.75 } }));
    expect(clock.pending()).toBe(0);
    flush(1000);
    expect(records[0].renderer.draw).toHaveBeenCalledOnce();
  });

  it("snaps pointer input on context recovery BEFORE 180ms and immediately returns to zero idle frames", async () => {
    const view = render(<LiquidGlassSurface>Tools</LiquidGlassSurface>);
    await intersect(); flush(16);
    act(() => records[0].options.onStatusChange?.("context-lost"));
    flush(32);
    fireEvent.pointerMove(surface(view.container), { clientX: 270, clientY: 36 });
    expect(clock.pending()).toBe(0);
    flush(64);
    act(() => records[0].options.onStatusChange?.("ready"));
    flush(80); // Recovery occurs within the old interpolation window.
    expect(records[0].renderer.draw).toHaveBeenLastCalledWith(expect.objectContaining({ pointer: { x: 0.9, y: 0.75 } }));
    expect(clock.pending()).toBe(0);
    flush(1000);
    expect(records[0].renderer.draw).toHaveBeenCalledTimes(2);
  });

  it.each(["missing", "lookup-throws", "lose-throws", "not-lost"] as const)("bounds ACTUAL contexts during island preemption and remount with %s release", async (mode) => {
    const contexts: ReturnType<typeof createMockGL>[] = [];
    let peak = 0;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      const mock = createMockGL();
      if (mode === "missing") mock.gl.getExtension.mockReturnValue(null);
      if (mode === "lookup-throws") mock.gl.getExtension.mockImplementation(() => { throw new Error("no extension"); });
      if (mode === "lose-throws") mock.loseContext.mockImplementation(() => { throw new Error("release failed"); });
      if (mode === "not-lost") mock.loseContext.mockImplementation(() => {});
      contexts.push(mock);
      peak = Math.max(peak, contexts.filter(({ gl }) => !gl.isContextLost()).length);
      return mock.context;
    });
    factory.mockImplementation(createGlassRenderer);
    const view = render(<><button><LiquidGlassSurface>A</LiquidGlassSurface></button><button><LiquidGlassSurface>B</LiquidGlassSurface></button><LiquidGlassSurface>Island</LiquidGlassSurface></>);
    await intersect(true, 0); await intersect(true, 1);
    const roots = view.container.querySelectorAll<HTMLElement>(".liquid-glass-surface");
    await act(async () => { fireEvent.pointerEnter(roots[0]); fireEvent.pointerEnter(roots[1]); });
    expect(contexts).toHaveLength(2);
    await intersect(true, 2);
    expect(contexts.filter(({ gl }) => !gl.isContextLost())).toHaveLength(2);
    expect(peak).toBe(2);
    expect(roots[2]).toHaveAttribute("data-glass-reason", "budget");
    view.unmount();
    const remounted = render(<LiquidGlassSurface>Later</LiquidGlassSurface>);
    await intersect(true, 3);
    expect(contexts).toHaveLength(2);
    expect(surface(remounted.container)).toHaveAttribute("data-glass-reason", "budget");
    expect(clock.pending()).toBe(0);
  });

  it.each(["shader-compile", "program-link"] as const)("counts unreleased contexts from %s construction failures against the same budget", async (reason) => {
    const contexts: ReturnType<typeof createMockGL>[] = [];
    let peak = 0;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      const mock = createMockGL();
      mock.gl.getExtension.mockReturnValue(null);
      if (reason === "shader-compile") mock.gl.getShaderParameter.mockReturnValue(false);
      else mock.gl.getProgramParameter.mockReturnValue(false);
      contexts.push(mock);
      peak = Math.max(peak, contexts.filter(({ gl }) => !gl.isContextLost()).length);
      return mock.context;
    });
    factory.mockImplementation(createGlassRenderer);
    const view = render(<><LiquidGlassSurface>A</LiquidGlassSurface><LiquidGlassSurface>B</LiquidGlassSurface><LiquidGlassSurface>C</LiquidGlassSurface></>);
    await intersect();
    expect(contexts.filter(({ gl }) => !gl.isContextLost())).toHaveLength(2);
    expect(peak).toBe(2);
    expect(view.container.querySelectorAll(`[data-glass-reason="${reason}"]`)).toHaveLength(2);
    expect(view.container.querySelectorAll('[data-glass-reason="budget"]')).toHaveLength(1);
    expect(view.container.querySelectorAll("canvas")).toHaveLength(0);
    expect(clock.pending()).toBe(0);
  });

  it("preempts controls without ever exceeding two live contexts when release is confirmed", async () => {
    const contexts: ReturnType<typeof createMockGL>[] = [];
    let peak = 0;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      const mock = createMockGL();
      contexts.push(mock);
      peak = Math.max(peak, contexts.filter(({ gl }) => !gl.isContextLost()).length);
      return mock.context;
    });
    factory.mockImplementation(createGlassRenderer);
    const view = render(<><button><LiquidGlassSurface>A</LiquidGlassSurface></button><button><LiquidGlassSurface>B</LiquidGlassSurface></button><LiquidGlassSurface>Island</LiquidGlassSurface></>);
    await intersect(true, 0); await intersect(true, 1);
    const roots = view.container.querySelectorAll<HTMLElement>(".liquid-glass-surface");
    await act(async () => { fireEvent.pointerEnter(roots[0]); fireEvent.pointerEnter(roots[1]); });
    await intersect(true, 2);
    expect(contexts).toHaveLength(3);
    expect(contexts.filter(({ gl }) => !gl.isContextLost())).toHaveLength(2);
    expect(peak).toBe(2);
    expect(roots[2]).toHaveAttribute("data-glass-state", "gpu");
    view.unmount();
    expect(contexts.filter(({ gl }) => !gl.isContextLost())).toHaveLength(0);
    render(<LiquidGlassSurface>Later</LiquidGlassSurface>);
    await intersect(true, 3); flush(16);
    expect(contexts).toHaveLength(4);
    expect(peak).toBe(2);
    expect(clock.pending()).toBe(0);
  });

  it("reserves a naturally lost context across unmount even if the browser later restores it", async () => {
    const contexts: ReturnType<typeof createMockGL>[] = [];
    const canvases: HTMLCanvasElement[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      const mock = createMockGL();
      contexts.push(mock); canvases.push(this);
      return mock.context;
    });
    factory.mockImplementation(createGlassRenderer);
    const view = render(<><LiquidGlassSurface key="a">A</LiquidGlassSurface><LiquidGlassSurface key="b">B</LiquidGlassSurface><LiquidGlassSurface key="c">C</LiquidGlassSurface></>);
    await intersect();
    expect(contexts).toHaveLength(2);
    contexts[0].gl.isContextLost.mockReturnValue(true);
    fireEvent(canvases[0], new Event("webglcontextlost", { cancelable: true }));
    view.rerender(<><LiquidGlassSurface key="b">B</LiquidGlassSurface><LiquidGlassSurface key="c">C</LiquidGlassSurface></>);
    await act(async () => {
      contexts[0].gl.isContextLost.mockReturnValue(false);
      canvases[0].dispatchEvent(new Event("webglcontextrestored"));
    });
    expect(contexts).toHaveLength(2);
    expect(contexts.filter(({ gl }) => !gl.isContextLost())).toHaveLength(2);
    expect(screen.getByText("C").closest(".liquid-glass-surface")).toHaveAttribute("data-glass-reason", "budget");
    flush(16);
    expect(clock.pending()).toBe(0);
  });

});
