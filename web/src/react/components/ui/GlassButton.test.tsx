import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Button } from "./Button";
import { GlassButton } from "./GlassButton";
import { LiquidGlassSurface } from "./LiquidGlassSurface";
import * as runtimeModule from "./glass/runtime";
import * as hookModule from "./glass/useGlassSurface";
import { createGlassScheduler } from "./glass/scheduler";
import { createFrameClock } from "./glass/__tests__/helpers";
import type { GlassRenderer, RendererResult } from "./glass/types";

let clock: ReturnType<typeof createFrameClock>;
let scheduler: ReturnType<typeof createGlassScheduler>;
let loadRenderer: Mock<runtimeModule.GlassRuntime["loadRenderer"]>;
let factory: Mock<(canvas: HTMLCanvasElement) => RendererResult>;
let renderers: GlassRenderer[];
let preferences: Set<string>;

beforeEach(() => {
  clock = createFrameClock();
  scheduler = createGlassScheduler(clock);
  renderers = [];
  preferences = new Set();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 96, 32),
  );
  // Use the real hook's viewport fallback: every surface is genuinely eligible
  // for layout/visibility purposes. Only control interaction should gate it.
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.stubGlobal("ResizeObserver", undefined);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    media: query,
    matches: preferences.has(query),
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  }));
  factory = vi.fn((_canvas: HTMLCanvasElement): RendererResult => {
    const renderer: GlassRenderer = {
      draw: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(() => true),
    };
    renderers.push(renderer);
    return { ok: true, renderer };
  });
  loadRenderer = vi.fn(async () => ({ createGlassRenderer: factory }));
  vi.spyOn(runtimeModule, "getGlassRuntime").mockReturnValue({ scheduler, loadRenderer });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settle() {
  await act(async () => { await Promise.resolve(); });
}

function surface(button: HTMLElement) {
  const node = button.closest<HTMLElement>(".glass-button-surface");
  if (!node) throw new Error("Expected an outer glass surface");
  return node;
}

describe("GlassButton native contract", () => {
  it("keeps exactly one native button and all decorative surface DOM outside it", () => {
    render(<GlassButton><span>Send</span></GlassButton>);
    const button = screen.getByRole("button", { name: "Send" });
    const root = surface(button);
    expect(screen.getAllByRole("button")).toEqual([button]);
    expect(root.tagName).toBe("DIV");
    expect(root).not.toHaveAttribute("role");
    expect(root).not.toHaveAttribute("tabindex");
    expect(button.tagName).toBe("BUTTON");
    expect(button.querySelector("button, .liquid-glass-surface, .liquid-glass-svg, canvas")).toBeNull();
    expect(root.querySelector("button button")).toBeNull();
    expect(root.querySelector(".liquid-glass-content")).toHaveStyle({ display: "contents" });
    expect(root.querySelector(".liquid-glass-svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("forwards the actual button ref, click once, native props and only button className", async () => {
    const user = userEvent.setup();
    const ref = createRef<HTMLButtonElement>();
    const click = vi.fn();
    const view = render(
      <GlassButton ref={ref} onClick={click} id="send" name="action" value="send"
        title="Send message" aria-describedby="hint" data-testid="send-button"
        className="native-button-class" surfaceClassName="flex-none self-end"
        style={{ minWidth: 80 }}>
        <span>Send</span>
      </GlassButton>,
    );
    const button = screen.getByRole("button", { name: "Send" });
    expect(ref.current).toBe(button);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(button).toHaveAttribute("id", "send");
    expect(button).toHaveAttribute("name", "action");
    expect(button).toHaveAttribute("value", "send");
    expect(button).toHaveAttribute("title", "Send message");
    expect(button).toHaveAttribute("aria-describedby", "hint");
    expect(button).toHaveAttribute("data-testid", "send-button");
    expect(button).toHaveStyle({ minWidth: "80px" });
    expect(button).toHaveClass("native-button-class");
    expect(surface(button)).toHaveClass("flex-none", "self-end");
    expect(surface(button)).not.toHaveClass("native-button-class");
    expect(button).not.toHaveClass("flex-none", "self-end");
    await user.click(screen.getByText("Send"));
    expect(click).toHaveBeenCalledOnce();
    fireEvent.click(surface(button));
    expect(click).toHaveBeenCalledOnce();
    view.unmount();
    expect(ref.current).toBeNull();
  });

  it("forwards focus and pointer events once and lets them reach the surface", async () => {
    const user = userEvent.setup();
    const focus = vi.fn();
    const move = vi.fn();
    render(<GlassButton onFocus={focus} onPointerMove={move}>Send</GlassButton>);
    const button = screen.getByRole("button");
    const surfaceFocus = vi.fn();
    const surfaceMove = vi.fn();
    surface(button).addEventListener("focusin", surfaceFocus);
    surface(button).addEventListener("pointermove", surfaceMove);
    await user.tab();
    expect(button).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
    expect(surfaceFocus).toHaveBeenCalledOnce();
    fireEvent.pointerMove(button, { clientX: 72, clientY: 24 });
    expect(move).toHaveBeenCalledOnce();
    expect(surfaceMove).toHaveBeenCalledOnce();
  });

  it("retains native Enter and Space activation without extra tab stops", async () => {
    const user = userEvent.setup();
    const click = vi.fn();
    render(<><GlassButton onClick={click}>Send</GlassButton><button>Next</button></>);
    await user.tab();
    expect(screen.getByRole("button", { name: "Send" })).toHaveFocus();
    await user.keyboard("{Enter} ");
    expect(click).toHaveBeenCalledTimes(2);
    await user.tab();
    expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
  });

  it("defaults to type=button and preserves explicit submit behavior", async () => {
    const user = userEvent.setup();
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const view = render(<form onSubmit={submit}><GlassButton>Send</GlassButton></form>);
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("type", "button");
    await user.click(button);
    expect(submit).not.toHaveBeenCalled();
    view.rerender(<form onSubmit={submit}><GlassButton type="submit">Send</GlassButton></form>);
    expect(screen.getByRole("button")).toBe(button);
    await user.click(button);
    expect(submit).toHaveBeenCalledOnce();
  });

  it.each([
    { disabled: true, pending: false },
    { disabled: false, pending: true },
    { disabled: true, pending: true },
  ])("preserves disabled/busy semantics for %o", async (state) => {
    const user = userEvent.setup();
    const click = vi.fn();
    const hook = vi.spyOn(hookModule, "useGlassSurface");
    render(<GlassButton {...state} onClick={click}>Send</GlassButton>);
    const button = screen.getByRole("button", { name: "Send" });
    expect(button).toBeDisabled();
    if (state.pending) expect(button).toHaveAttribute("aria-busy", "true");
    else expect(button).not.toHaveAttribute("aria-busy");
    expect(hook).toHaveBeenLastCalledWith(false, "subtle", true);
    await user.click(button);
    await user.tab();
    expect(button).not.toHaveFocus();
    expect(click).not.toHaveBeenCalled();
  });

  it("preserves pending render props and does not add a second spinner", () => {
    const view = render(
      <GlassButton pending>{({ pending }) => <span>{pending ? "Sending" : "Send"}</span>}</GlassButton>,
    );
    const button = screen.getByRole("button", { name: "Sending" });
    expect(button).toBeDisabled();
    expect(button.querySelectorAll(".animate-spin")).toHaveLength(0);
    view.rerender(<GlassButton pending>Send</GlassButton>);
    expect(button.querySelectorAll(".animate-spin")).toHaveLength(1);
    view.rerender(<GlassButton>Send</GlassButton>);
    expect(screen.getByRole("button")).toBe(button);
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-busy");
    expect(button.querySelectorAll(".animate-spin")).toHaveLength(0);
  });

  it.each(["xs", "sm", "md", "lg"] as const)("retains %s icon-only sizing on the button", (size) => {
    render(<GlassButton size={size} iconOnly aria-label="Send"><span aria-hidden="true">↑</span></GlassButton>);
    const button = screen.getByRole("button", { name: "Send" });
    expect(button).toHaveClass({ xs: "w-6", sm: "w-7", md: "w-8", lg: "w-10" }[size], "!px-0");
    expect(surface(button)).not.toHaveClass("!px-0");
  });

  it.each([
    ["primary", "strong"], ["danger", "strong"], ["secondary", "subtle"],
    ["tertiary", "subtle"], ["ghost", "subtle"], ["outline", "subtle"], ["danger-soft", "subtle"],
  ] as const)("uses the %s variant's %s optical treatment", (variant, intensity) => {
    render(<GlassButton variant={variant}>Send</GlassButton>);
    expect(surface(screen.getByRole("button"))).toHaveClass(`liquid-glass-surface--${intensity}`);
  });
});

describe("GlassButton real glass eligibility", () => {
  it("keeps ordinary Button static without registering a glass surface", async () => {
    const register = vi.spyOn(scheduler, "registerContext");
    render(<Button>Plain</Button>);
    await settle();
    expect(register).not.toHaveBeenCalled();
    expect(loadRenderer).not.toHaveBeenCalled();
  });

  it("defaults to a static rim and registers opt-in glass at control priority", async () => {
    const register = vi.spyOn(scheduler, "registerContext");
    render(<GlassButton>Send</GlassButton>);
    await settle();
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ priority: "control" }));
    expect(loadRenderer).not.toHaveBeenCalled();
    expect(surface(screen.getByRole("button"))).toHaveAttribute("data-glass-reason", "static");
    expect(clock.pending()).toBe(0);
  });

  it("acquires on pointer entry, reads bubbled input, and releases on exit", async () => {
    const user = userEvent.setup();
    render(<GlassButton>Send</GlassButton>);
    const button = screen.getByRole("button");
    await settle();
    expect(loadRenderer).not.toHaveBeenCalled();
    await user.hover(button);
    await settle();
    expect(factory).toHaveBeenCalledOnce();
    expect(surface(button)).toHaveAttribute("data-glass-state", "gpu");
    fireEvent.pointerMove(button, { clientX: 72, clientY: 24 });
    act(() => clock.flush(250));
    expect(renderers[0].draw).toHaveBeenLastCalledWith(expect.objectContaining({ pointer: { x: 0.75, y: 0.75 } }));
    await user.unhover(button);
    expect(renderers[0].dispose).toHaveBeenCalledOnce();
    expect(surface(button)).toHaveAttribute("data-glass-reason", "static");
    expect(clock.pending()).toBe(0);
  });

  it("acquires through keyboard focus and releases on blur without replacing the button", async () => {
    const user = userEvent.setup();
    const ref = createRef<HTMLButtonElement>();
    render(<><GlassButton ref={ref}>Send</GlassButton><button>Next</button></>);
    const button = screen.getByRole("button", { name: "Send" });
    await settle();
    expect(loadRenderer).not.toHaveBeenCalled();
    await user.tab();
    await settle();
    expect(factory).toHaveBeenCalledOnce();
    expect(button).toHaveFocus();
    expect(ref.current).toBe(button);
    await user.tab();
    expect(renderers[0].dispose).toHaveBeenCalledOnce();
    expect(surface(button)).toHaveAttribute("data-glass-reason", "static");
  });

  it.each([{ disabled: true }, { pending: true }])("never enhances an initially inactive control: %o", async (state) => {
    const user = userEvent.setup();
    render(<GlassButton {...state}>Send</GlassButton>);
    await user.hover(screen.getByRole("button"));
    await settle();
    expect(loadRenderer).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });

  it.each([{ disabled: true }, { pending: true }])("releases active enhancement when the button becomes %o", async (state) => {
    const user = userEvent.setup();
    const view = render(<GlassButton>Send</GlassButton>);
    const button = screen.getByRole("button");
    await user.hover(button);
    await settle();
    expect(factory).toHaveBeenCalledOnce();
    view.rerender(<GlassButton {...state}>Send</GlassButton>);
    await settle();
    expect(screen.getByRole("button")).toBe(button);
    expect(button).toBeDisabled();
    expect(renderers[0].dispose).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
    expect(surface(button).querySelector("canvas")).toBeNull();
    expect(clock.pending()).toBe(0);
  });

  it("respects both the shared two-context cap and island priority", async () => {
    const view = render(<><GlassButton>A</GlassButton><GlassButton>B</GlassButton><GlassButton>C</GlassButton></>);
    for (const button of screen.getAllByRole("button")) {
      fireEvent.pointerEnter(surface(button));
    }
    await settle();
    expect(view.container.querySelectorAll("canvas")).toHaveLength(2);
    view.rerender(<><GlassButton>A</GlassButton><GlassButton>B</GlassButton><GlassButton>C</GlassButton>
      <LiquidGlassSurface className="test-island">Island</LiquidGlassSurface></>);
    await settle();
    expect(view.container.querySelectorAll("canvas")).toHaveLength(2);
    expect(view.container.querySelector(".test-island")).toHaveAttribute("data-glass-state", "gpu");
    expect(view.container.querySelectorAll(".glass-button-surface canvas")).toHaveLength(1);
  });

  it.each([
    ["(prefers-reduced-motion: reduce)", "reduced-motion"],
    ["(prefers-reduced-transparency: reduce)", "reduced-transparency"],
    ["(prefers-contrast: more)", "high-contrast"],
    ["(forced-colors: active)", "high-contrast"],
  ])("leaves %s fallback eligibility with the existing renderer", async (query, reason) => {
    preferences.add(query);
    const user = userEvent.setup();
    const click = vi.fn();
    render(<GlassButton onClick={click}>Send</GlassButton>);
    const button = screen.getByRole("button");
    await user.click(button);
    await settle();
    expect(button).toHaveFocus();
    expect(click).toHaveBeenCalledOnce();
    expect(surface(button)).toHaveAttribute("data-glass-reason", reason);
    expect(loadRenderer).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });

  it("keeps the native action usable after renderer loading fails", async () => {
    loadRenderer.mockRejectedValue(new Error("renderer unavailable"));
    const user = userEvent.setup();
    const click = vi.fn();
    render(<GlassButton onClick={click}>Send</GlassButton>);
    const button = screen.getByRole("button");
    await user.click(button);
    await settle();
    expect(click).toHaveBeenCalledOnce();
    expect(button).toHaveFocus();
    expect(surface(button)).toHaveAttribute("data-glass-reason", "load-error");
    expect(surface(button).querySelector("canvas")).toBeNull();
  });
});
