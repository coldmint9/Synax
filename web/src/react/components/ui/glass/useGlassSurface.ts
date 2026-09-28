import { useEffect, useRef, useState } from "react";
import { getGlassRuntime } from "./runtime";
import type { GlassFallbackReason, GlassPointer, GlassRenderer, GlassSize, GlassSurfaceState, RendererFailure } from "./types";

const SETTLE_MS = 180;
const clamp = (value: number) => Math.min(1, Math.max(0, value));
// RO owns actual size changes; IO owns visibility. Compositor motion is not a theme change.
const motionStyles = new Set(['transform', 'transform-origin', 'translate', 'rotate', 'scale', 'opacity', 'width', 'height', 'left', 'top', 'right', 'bottom', 'will-change']);
function appearanceStyle(element: Element): string {
  if (!(element instanceof HTMLElement)) return element.getAttribute('style') ?? '';
  return Array.from(element.style).filter((name) => !motionStyles.has(name))
    .map((name) => `${name}:${element.style.getPropertyValue(name)}!${element.style.getPropertyPriority(name)}`).join(';');
}


/** React owns eligibility; the renderer owns GL resources and never owns a RAF. */
export function useGlassSurface(interactive: boolean, intensity: "subtle" | "strong", optical = true) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const gpuHostRef = useRef<HTMLSpanElement>(null);
  const pointer = useRef<GlassPointer>({ x: 0.5, y: 0.5 });
  const [state, setState] = useState<GlassSurfaceState>({ mode: "fallback", reason: "static" });
  const runtime = getGlassRuntime();

  useEffect(() => {
    const surfaceNode = surfaceRef.current;
    const hostNode = gpuHostRef.current;
    if (!surfaceNode || !hostNode) return;
    const surface: HTMLDivElement = surfaceNode;
    const host: HTMLSpanElement = hostNode;
    const { scheduler, loadRenderer } = runtime;
    const queries = {
      motion: window.matchMedia("(prefers-reduced-motion: reduce)"),
      transparency: window.matchMedia("(prefers-reduced-transparency: reduce)"),
      contrast: window.matchMedia("(prefers-contrast: more)"),
      forcedColors: window.matchMedia("(forced-colors: active)"),
      dark: window.matchMedia("(prefers-color-scheme: dark)"),
    };
    // Valid button markup puts the optical surface outside the native control.
    // Treat that opt-in wrapper as a control too; it must never acquire an idle island lease.
    const controlElement = surface.closest<HTMLElement>(".glass-button-surface, button, [role='button']");
    const control = controlElement !== null;
    const focusTarget = controlElement ?? surface;
    let alive = true;
    let granted = false;
    let ready = false;
    let contextReleased = true;
    let epoch = 0;
    let renderer: GlassRenderer | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let failure: RendererFailure | "load-error" | null = null;
    let hovered = false;
    let focused = focusTarget.contains(document.activeElement);
    let intersecting = false;
    let dark = false;
    let size: GlassSize = { width: 0, height: 0, dpr: 1, radius: 0 };
    const displayed: GlassPointer = { ...pointer.current };
    let origin: GlassPointer = { ...displayed };
    let inputAt = -Infinity;

    const report = (next: GlassSurfaceState) => {
      if (alive) setState((previous) => previous.mode === next.mode && previous.reason === next.reason ? previous : next);
    };
    function fallbackReason(): GlassFallbackReason | null {
      if (queries.motion.matches) return "reduced-motion";
      if (queries.transparency.matches) return "reduced-transparency";
      if (queries.contrast.matches || queries.forcedColors.matches) return "high-contrast";
      if (!optical) return "static";
      if (document.visibilityState === "hidden") return "hidden";
      if (!intersecting || size.width <= 0 || size.height <= 0) return "offscreen";
      if (failure) return failure;
      if (control && (!interactive || (!hovered && !focused))) return "static";
      return null;
    }
    function draw(time: number) {
      if (!alive || !ready || !renderer || fallbackReason()) return;
      const progress = clamp((time - inputAt) / SETTLE_MS);
      const eased = 1 - Math.pow(1 - progress, 3);
      // Read the ref NOW, never a pointer object captured during initialization.
      displayed.x = origin.x + (pointer.current.x - origin.x) * eased;
      displayed.y = origin.y + (pointer.current.y - origin.y) * eased;
      renderer.draw({ pointer: { ...displayed }, intensity: intensity === "strong" ? 1 : 0.72, dark });
    }
    const unsubscribe = scheduler.subscribe(draw);

    function release() {
      granted = false;
      ready = false;
      epoch++;
      scheduler.cancel(draw);
      try {
        if (renderer) contextReleased = renderer.dispose() === true;
      } catch { contextReleased = false; }
      renderer = null;
      canvas?.remove();
      canvas = null;
      report({ mode: "fallback", reason: fallbackReason() ?? "budget" });
      return contextReleased;
    }
    function readyToDraw() {
      ready = true;
      if (canvas) canvas.hidden = false;
      renderer?.resize(size);
      // Input can arrive while loading/lost. Snap to its latest value rather
      // than stranding a partial interpolation after the single recovery frame.
      displayed.x = pointer.current.x;
      displayed.y = pointer.current.y;
      origin = { ...displayed };
      inputAt = -Infinity;
      report({ mode: "gpu" });
      scheduler.request(draw);
    }
    function fail(reason: RendererFailure | "load-error") {
      failure = reason;
      updateEligibility();
    }
    function acquire() {
      granted = true;
      contextReleased = true; // No context exists while the module is loading.
      const generation = ++epoch;
      report({ mode: "loading" });
      // A revoked async acquisition still counts against the budget until revoked;
      // its epoch check ensures it can NEVER create a late third context.
      void Promise.resolve().then(() => {
        if (!alive || !granted || generation !== epoch) return null;
        return loadRenderer();
      }).then((module) => {
        if (!module || !alive || !granted || generation !== epoch) return;
        canvas = document.createElement("canvas");
        canvas.className = "liquid-glass-canvas";
        canvas.setAttribute("aria-hidden", "true");
        host.appendChild(canvas);
        // Even a throwing factory may have allocated a context before failing.
        contextReleased = false;
        const result = module.createGlassRenderer(canvas, {
          onStatusChange(status) {
            if (!alive || generation !== epoch) return;
            if (status === "ready") {
              readyToDraw();
            } else if (status === "context-lost") {
              ready = false;
              if (canvas) canvas.hidden = true;
              scheduler.cancel(draw);
              report({ mode: "fallback", reason: "context-lost" });
            } else fail(status);
          },
        });
        if (!result.ok) {
          contextReleased = result.contextReleased;
          fail(result.reason);
          return;
        }
        renderer = result.renderer;
        readyToDraw();
      }).catch(() => {
        if (alive && granted && generation === epoch) fail("load-error");
      });
    }
    const lease = scheduler.registerContext({ priority: control ? "control" : "island", acquire, release });

    function updateEligibility() {
      if (!alive) return;
      const reason = fallbackReason();
      lease.setEligible(reason === null);
      if (reason) report({ mode: "fallback", reason });
      else if (!granted) report({ mode: "fallback", reason: "budget" });
    }
    function updateAppearance(computed: CSSStyleDeclaration): boolean {
      const radiusText = computed.borderTopLeftRadius;
      const parsedRadius = Number.parseFloat(radiusText);
      const radius = Number.isFinite(parsedRadius)
        ? parsedRadius * (radiusText.endsWith("%") ? Math.min(size.width, size.height) / 100 : 1)
        : 16;
      const nextRadius = Math.min(Math.max(0, radius), size.width / 2, size.height / 2);
      const changed = nextRadius !== size.radius;
      size.radius = nextRadius;
      if (changed) surface.style.setProperty("--glass-radius", `${size.radius}px`);
      dark = surface.closest(".dark, [data-theme='dark']") !== null
        || (surface.closest(".light, [data-theme='light']") === null && (computed.colorScheme === "dark" || queries.dark.matches));
      surface.dataset.glassTheme = dark ? "dark" : "light";
      return changed;
    }
    function measure() {
      const bounds = surface.getBoundingClientRect();
      size = { ...size, width: bounds.width, height: bounds.height, dpr: window.devicePixelRatio || 1 };
      updateAppearance(getComputedStyle(surface));
      if (typeof IntersectionObserver === "undefined") {
        intersecting = bounds.bottom > 0 && bounds.right > 0 && bounds.top < window.innerHeight && bounds.left < window.innerWidth;
      }
      renderer?.resize(size);
    }
    function refreshAppearance() {
      if (!alive) return;
      // Class/theme changes need style, not a forced document layout. RO/IO handle geometry.
      if (updateAppearance(getComputedStyle(surface))) renderer?.resize(size);
      if (ready) scheduler.request(draw);
    }
    function refresh() {
      if (!alive) return;
      measure();
      updateEligibility();
      if (ready) scheduler.request(draw);
    }
    function visibilityChanged() {
      scheduler.setVisible(document.visibilityState !== "hidden");
      refresh();
    }
    function moveTo(x: number, y: number) {
      pointer.current.x = clamp(x);
      pointer.current.y = clamp(y);
      origin = { ...displayed };
      inputAt = scheduler.now();
      if (ready) scheduler.request(draw, SETTLE_MS);
    }
    function pointerMove(event: PointerEvent) {
      const bounds = surface.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      moveTo((event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height);
    }
    function pointerEnter() { hovered = true; updateEligibility(); }
    function pointerLeave() {
      hovered = false;
      moveTo(0.5, 0.5);
      updateEligibility(); // Controls return their slot immediately on exit.
    }
    function focusIn() { focused = true; updateEligibility(); }
    function focusOut(event: FocusEvent) {
      if (event.relatedTarget instanceof Node && focusTarget.contains(event.relatedTarget)) return;
      focused = false;
      updateEligibility();
    }

    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refresh);
    resize?.observe(surface);
    const intersection = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
      if (!alive) return;
      // A batch can contain multiple transitions for the same surface.
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.target !== surface) continue;
        // At threshold 0, edge-adjacent true/0 may not notify again when the
        // ratio becomes positive. Eligibility must follow isIntersecting.
        intersecting = entry.isIntersecting;
        refresh();
        break;
      }
    });
    intersection?.observe(surface);
    // No layout/theme polling. Observe only this surface's ancestry, not the app subtree.
    const ancestorStyles = new WeakMap<Element, string>();
    const theme = typeof MutationObserver === "undefined" ? null : new MutationObserver((changes) => {
      let changed = false;
      for (const change of changes) {
        if (change.attributeName !== "style") { changed = true; continue; }
        const element = change.target as Element;
        const next = appearanceStyle(element);
        if (ancestorStyles.get(element) !== next) changed = true;
        ancestorStyles.set(element, next);
      }
      if (changed) refreshAppearance();
    });
    // Portal effects can run while their mount is detached. Always watch the
    // app theme root as it may not be in the initial ancestry walk below.
    ancestorStyles.set(document.documentElement, appearanceStyle(document.documentElement));
    theme?.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    theme?.observe(surface, { attributes: true, attributeFilter: ["class", "data-theme"] });
    for (let parent = surface.parentElement; parent; parent = parent.parentElement) {
      ancestorStyles.set(parent, appearanceStyle(parent));
      theme?.observe(parent, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    }
    for (const query of Object.values(queries)) query.addEventListener("change", refresh);
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("resize", refresh); // Also notices device-pixel-ratio changes.
    if (!intersection) window.addEventListener("scroll", refresh, { passive: true, capture: true });
    if (interactive) {
      surface.addEventListener("pointermove", pointerMove, { passive: true });
      surface.addEventListener("pointerenter", pointerEnter, { passive: true });
      surface.addEventListener("pointerleave", pointerLeave, { passive: true });
      focusTarget.addEventListener("focusin", focusIn);
      focusTarget.addEventListener("focusout", focusOut);
    }
    visibilityChanged();

    return () => {
      alive = false;
      epoch++;
      resize?.disconnect();
      intersection?.disconnect();
      theme?.disconnect();
      for (const query of Object.values(queries)) query.removeEventListener("change", refresh);
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("resize", refresh);
      if (!intersection) window.removeEventListener("scroll", refresh, true);
      surface.removeEventListener("pointermove", pointerMove);
      surface.removeEventListener("pointerenter", pointerEnter);
      surface.removeEventListener("pointerleave", pointerLeave);
      focusTarget.removeEventListener("focusin", focusIn);
      focusTarget.removeEventListener("focusout", focusOut);
      lease.dispose();
      unsubscribe();
    };
  }, [interactive, intensity, optical, runtime]);

  return { surfaceRef, gpuHostRef, state };
}
