import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerEffortControl } from "../ComposerEffortControl";
import type { ReasoningEffort } from "../../../../adapters/transport/agentRuntime";
import { ALL_REASONING_EFFORTS } from "../../../settings/lib/providerPresets";

const context = { setTransform: vi.fn(), clearRect: vi.fn(), fillText: vi.fn(), fillRect: vi.fn() };
let callbacks: Map<number, FrameRequestCallback>;
let sequence: number;
let reduced: boolean;
let media: MediaQueryList;
let animations: Array<{ target: Element; frames: Keyframe[]; cancel: ReturnType<typeof vi.fn> }>;
const disconnect = vi.fn();

beforeEach(() => {
  callbacks = new Map();
  sequence = 0;
  reduced = false;
  animations = [];
  const events = new EventTarget();
  media = {
    get matches() { return reduced; },
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  } as MediaQueryList;
  vi.spyOn(window, "matchMedia").mockReturnValue(media);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { callbacks.delete(id); });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect = disconnect;
  });
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: function (frames: Keyframe[]) {
      const animation = { target: this as Element, frames, cancel: vi.fn(), finished: new Promise(() => {}) };
      animations.push(animation);
      return animation;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete (Element.prototype as Partial<Element>).animate;
});

function frame(now = performance.now() + 100) {
  act(() => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach(callback => callback(now));
  });
}

function control(effort: ReasoningEffort, levels = ALL_REASONING_EFFORTS, onChange = vi.fn()) {
  return <ComposerEffortControl effort={effort} levels={levels} label="思考强度" onChange={onChange} />;
}

function ringAnimations() {
  return animations.filter(animation => animation.target.classList.contains("composer-effort-impact-ring"));
}

describe("ComposerEffortControl", () => {
  it("paints glyphs and glow in the canvas theme accent and updates idle colors without starting animation", async () => {
    const nativeStyle = globalThis.getComputedStyle;
    let accent = "rgb(190, 70, 120)";
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation(element =>
      element instanceof HTMLCanvasElement ? { color: accent } as CSSStyleDeclaration : nativeStyle(element),
    );
    const paints: Array<{ color: string; glow: string; blur: number }> = [];
    const drawing = context as unknown as CanvasRenderingContext2D;
    context.fillText.mockImplementation(() => {
      paints.push({ color: String(drawing.fillStyle), glow: drawing.shadowColor, blur: drawing.shadowBlur });
    });
    render(control("high"));
    expect(paints.length).toBeGreaterThan(0);
    expect(paints.every(paint => paint.color === accent && paint.glow === accent)).toBe(true);
    expect(paints.some(paint => paint.blur > 0)).toBe(true);
    expect(callbacks.size).toBe(0);
    accent = "rgb(30, 140, 110)";
    const previousStyle = document.documentElement.getAttribute("style");
    try {
      act(() => { document.documentElement.style.setProperty("--effort-test-accent", accent); });
      await waitFor(() => expect(drawing.fillStyle).toBe(accent));
      expect(drawing.shadowColor).toBe(accent);
      expect(callbacks.size).toBe(0);
    } finally {
      if (previousStyle === null) document.documentElement.removeAttribute("style");
      else document.documentElement.setAttribute("style", previousStyle);
    }
  });

  it("maps native slider indices to allowed levels and waits for controlled updates", () => {
    const change = vi.fn();
    const view = render(control("low", ["low", "high", "max"], change));
    const slider = screen.getByRole("slider", { name: "思考强度" });
    expect(slider).toHaveAttribute("max", "2");
    expect(slider).toHaveAttribute("aria-valuetext", "low (低)");
    fireEvent.change(slider, { target: { value: "1" } });
    expect(change).toHaveBeenLastCalledWith("high");
    expect(slider).toHaveValue("0");
    view.rerender(control("high", ["low", "high", "max"], change));
    expect(slider).toHaveValue("1");
    expect(slider).toHaveAttribute("aria-valuetext", "high (高)");
  });

  it("supports controlled drag selection without offering disallowed levels", () => {
    const change = vi.fn();
    function Controlled() {
      const [effort, setEffort] = useState<ReasoningEffort>("low");
      return control(effort, ["low", "high"], next => { change(next); setEffort(next); });
    }
    render(<Controlled />);
    const slider = screen.getByRole("slider");
    fireEvent.pointerDown(slider, { button: 0, pointerId: 1 });
    fireEvent.change(slider, { target: { value: "1" } });
    fireEvent.pointerUp(slider);
    expect(change).toHaveBeenCalledExactlyOnceWith("high");
    expect(slider).toHaveValue("1");
    expect(document.querySelector(".composer-effort-control")).toHaveAttribute("data-motion", "idle");
    expect(callbacks.size).toBe(0);
  });

  it("disables a single-level slider and centers its thumb", () => {
    const change = vi.fn();
    render(control("high", ["high"], change));
    const slider = screen.getByRole("slider");
    expect(slider).toBeDisabled();
    fireEvent.change(slider, { target: { value: "1" } });
    expect(change).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>(".composer-effort-thumb")?.style.left).toBe("50%");
  });

  it("animates lower levels only while dragging and clears work on cancel or blur", () => {
    render(control("high"));
    const slider = screen.getByRole("slider");
    const visual = document.querySelector(".composer-effort-control");
    expect(callbacks.size).toBe(0);
    expect(context.fillText).toHaveBeenCalled();
    fireEvent.pointerDown(slider, { button: 0 });
    expect(visual).toHaveAttribute("data-motion", "drag");
    expect(callbacks.size).toBe(1);
    frame();
    expect(callbacks.size).toBe(1);
    fireEvent.pointerCancel(window);
    expect(visual).toHaveAttribute("data-motion", "idle");
    expect(callbacks.size).toBe(0);
    fireEvent.pointerDown(slider, { button: 0 });
    fireEvent.blur(window);
    expect(callbacks.size).toBe(0);
  });

  it("loops only the actual max level, not a provider's last allowed level", () => {
    const view = render(control("xhigh", ["low", "xhigh"]));
    expect(callbacks.size).toBe(0);
    view.rerender(control("max", ["low", "max"]));
    expect(document.querySelector(".composer-effort-control")).toHaveAttribute("data-motion", "loop");
    expect(callbacks.size).toBe(1);
    frame();
    frame(performance.now() + 400);
    expect(context.fillRect).toHaveBeenCalled();
    expect(callbacks.size).toBe(1);
    expect(document.querySelector(".composer-effort-title-text")).toHaveTextContent("max");
    view.rerender(control("low", ["low", "max"]));
    expect(callbacks.size).toBe(0);
  });

  it("does not emit arrival on opening max; emits once per transition into max", () => {
    const view = render(control("max"));
    expect(ringAnimations()).toHaveLength(0);
    view.rerender(control("high"));
    view.rerender(control("max"));
    expect(ringAnimations()).toHaveLength(1);
    expect(ringAnimations()[0].frames[1].transform).toBe("scale(3.2)");
    view.rerender(control("max"));
    expect(ringAnimations()).toHaveLength(1);
    view.rerender(control("low"));
    expect(ringAnimations()[0].cancel).toHaveBeenCalled();
    view.rerender(control("max"));
    expect(ringAnimations()).toHaveLength(2);
  });

  it("slides titles in both directions and removes old layers during rapid changes", () => {
    const view = render(control("low"));
    view.rerender(control("high"));
    const enters = () => animations.filter(animation => animation.target.classList.contains("composer-effort-title-item") && !animation.target.classList.contains("composer-effort-title-ghost"));
    expect(enters()[0].frames[0].transform).toBe("translateX(48px)");
    view.rerender(control("medium"));
    expect(enters()[1].frames[0].transform).toBe("translateX(-48px)");
    expect(document.querySelectorAll(".composer-effort-title-ghost")).toHaveLength(1);
    expect(enters()[0].cancel).toHaveBeenCalled();
    view.unmount();
    expect(enters()[1].cancel).toHaveBeenCalled();
    expect(document.querySelectorAll(".composer-effort-title-ghost")).toHaveLength(0);
  });

  it("stops animation when reduced motion is enabled dynamically", () => {
    const view = render(control("high"));
    view.rerender(control("max"));
    expect(callbacks.size).toBe(1);
    act(() => { reduced = true; media.dispatchEvent(new Event("change")); });
    expect(callbacks.size).toBe(0);
    expect(document.querySelector(".composer-effort-control")).toHaveAttribute("data-motion", "idle");
    expect(document.querySelector(".composer-effort-title-text")).toHaveTextContent("max");
    expect(ringAnimations()[0].cancel).toHaveBeenCalled();
    act(() => { reduced = false; media.dispatchEvent(new Event("change")); });
    expect(callbacks.size).toBe(1);
    expect(ringAnimations()).toHaveLength(1);
  });

  it("pauses when hidden, resumes when visible, and disconnects on unmount", () => {
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const view = render(control("max"));
    expect(callbacks.size).toBe(1);
    act(() => { hidden = true; document.dispatchEvent(new Event("visibilitychange")); });
    expect(callbacks.size).toBe(0);
    act(() => { hidden = false; document.dispatchEvent(new Event("visibilitychange")); });
    expect(callbacks.size).toBe(1);
    view.unmount();
    expect(callbacks.size).toBe(0);
    expect(disconnect).toHaveBeenCalled();
  });
});
