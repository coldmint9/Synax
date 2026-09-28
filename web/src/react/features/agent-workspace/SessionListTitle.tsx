import { useLayoutEffect, useRef, type ReactNode } from "react";
import { SearchHighlight } from "./SearchHighlight";

const HOVER_DELAY_MS = 500;
const SCROLL_PX_PER_SECOND = 25;

/** One accessible title; the edge-only blur is a non-interactive visual copy. */
export function SessionListTitle({
  title,
  query,
  prefix,
  suffix,
}: {
  title: string;
  query?: string;
  prefix?: ReactNode;
  suffix?: ReactNode;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const viewportRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const blurRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const viewport = viewportRef.current;
    const text = textRef.current;
    const blur = blurRef.current;
    if (!root || !viewport || !text || !blur) return;
    root.title = title;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let hovered = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let animation: Animation | undefined;
    let blurAnimation: Animation | undefined;
    let width = -1;
    let textWidth = -1;

    const measure = () => {
      const nextWidth = viewport.clientWidth;
      // The sharp text is clipped by its own layer; viewport.scrollWidth no
      // longer includes the overflow. Measure the untransformed text instead.
      const nextTextWidth = text.scrollWidth;
      const changed = width !== nextWidth || textWidth !== nextTextWidth;
      width = nextWidth;
      textWidth = nextTextWidth;
      const overflowing = width > 0 && textWidth > width + 1;
      if (overflowing) {
        viewport.dataset.overflow = "true";
        if (!blur.firstElementChild) {
          // Clone only our escaped, non-interactive SearchHighlight output.
          // Keeping identical markup aligns bold search hits in both layers.
          const copy = text.cloneNode(true) as HTMLSpanElement;
          copy.className = "session-list-title-blur-text";
          blur.replaceChildren(copy);
        }
      } else {
        delete viewport.dataset.overflow;
        blur.replaceChildren();
      }
      return changed;
    };
    const reset = () => {
      clearTimeout(timer);
      timer = undefined;
      if (animation) {
        animation.onfinish = null;
        animation.cancel();
      }
      animation = undefined;
      blurAnimation?.cancel();
      blurAnimation = undefined;
      delete viewport.dataset.scrolling;
      delete viewport.dataset.atEnd;
      root.title = title;
    };
    const schedule = () => {
      reset();
      measure();
      if (!hovered || motion.matches || typeof text.animate !== "function" || !viewport.dataset.overflow) return;
      timer = setTimeout(() => {
        timer = undefined;
        measure();
        if (!hovered || motion.matches || !viewport.dataset.overflow) return;
        const distance = textWidth - width;
        root.removeAttribute("title");
        viewport.dataset.scrolling = "true";
        const frames = [{ transform: "translateX(0)" }, { transform: `translateX(-${distance}px)` }];
        const timing: KeyframeAnimationOptions = {
          duration: distance / SCROLL_PX_PER_SECOND * 1000,
          easing: "linear",
          fill: "forwards",
          iterations: 1,
        };
        const current = text.animate(frames, timing);
        animation = current;
        const copy = blur.firstElementChild as HTMLElement | null;
        if (typeof copy?.animate === "function") blurAnimation = copy.animate(frames, timing);
        const startTime = document.timeline?.currentTime;
        if (typeof startTime === "number") {
          current.startTime = startTime;
          if (blurAnimation) blurAnimation.startTime = startTime;
        }
        current.onfinish = () => {
          if (animation !== current || !hovered) return;
          // The last characters must be fully readable, not left under a mask.
          viewport.dataset.atEnd = "true";
          blurAnimation?.cancel();
          blurAnimation = undefined;
        };
      }, HOVER_DELAY_MS);
    };
    const remeasure = () => {
      if (measure()) schedule();
    };
    const leave = () => {
      hovered = false;
      reset();
      measure();
    };
    const enter = (event?: PointerEvent) => {
      if (event?.pointerType === "touch" || hovered) return;
      hovered = true;
      schedule();
    };

    // Overflow needs measuring before hover too, including sidebar resizes,
    // font loads and the narrower width when the row's actions become visible.
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(remeasure) : undefined;
    observer?.observe(viewport);
    observer?.observe(text);
    if (!observer) {
      window.addEventListener("resize", remeasure);
      document.fonts?.addEventListener("loadingdone", remeasure);
    }
    measure();
    root.addEventListener("pointerenter", enter);
    root.addEventListener("pointerleave", leave);
    motion.addEventListener("change", schedule);
    window.addEventListener("blur", leave);
    if (root.matches(":hover")) enter();
    return () => {
      reset();
      observer?.disconnect();
      blur.replaceChildren();
      delete viewport.dataset.overflow;
      root.removeEventListener("pointerenter", enter);
      root.removeEventListener("pointerleave", leave);
      motion.removeEventListener("change", schedule);
      window.removeEventListener("blur", leave);
      window.removeEventListener("resize", remeasure);
      document.fonts?.removeEventListener("loadingdone", remeasure);
    };
  }, [title, query]);

  return (
    <span ref={rootRef} className="session-list-title" title={title}>
      {prefix}
      <span ref={viewportRef} className="session-list-title-viewport">
        <span className="session-list-title-sharp">
          <span ref={textRef} className="session-list-title-text">
            <SearchHighlight text={title} query={query} />
          </span>
        </span>
        <span ref={blurRef} className="session-list-title-blur" aria-hidden="true" />
      </span>
      {suffix}
    </span>
  );
}
