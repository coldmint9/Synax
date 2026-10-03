import {
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { loadMotion, reducedMotion } from "../../shared/design/motion";
import { IslandSurface } from "./IslandSurface";

/** Keep the slot mounted so both its width and its sibling's position can retract. */
export function ToolbarPill({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(visible);
  const slotRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (slot && !reducedMotion()) {
      slot.style.width = "0px";
      slot.style.opacity = "0";
      slot.style.transform = "translateX(-8px)";
    }
  }, []);

  useLayoutEffect(() => {
    if (visible) setMounted(true);
  }, [visible]);

  useEffect(() => {
    if (visible) return;
    const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? 0
      : 280;
    const timer = window.setTimeout(() => setMounted(false), delay);
    return () => window.clearTimeout(timer);
  }, [visible]);

  useEffect(() => {
    const pill = pillRef.current;
    if (!pill) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries.find((entry) => entry.target === pill)?.borderBoxSize?.[0];
      setWidth(Math.round(box?.inlineSize ?? pill.offsetWidth));
    });
    // Wait for the browser's completed layout instead of forcing it during commit.
    observer.observe(pill);
    return () => observer.disconnect();
  }, [mounted]);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot || !mounted || (visible && width === 0)) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    let epoch = 0;
    const settle = () => {
      slot.style.removeProperty("width");
      slot.style.removeProperty("opacity");
      slot.style.removeProperty("transform");
    };
    const animate = async () => {
      const current = ++epoch;
      if (reducedMotion()) { settle(); return; }
      const motion = await loadMotion().catch(() => null);
      if (disposed || current !== epoch) return;
      if (!motion || reducedMotion()) { settle(); return; }
      const gap = parseFloat(getComputedStyle(slot).getPropertyValue("--toolbar-gap")) || 8;
      motion.to(slot, {
        width: visible ? width + gap : 0,
        opacity: visible ? 1 : 0,
        x: visible ? 0 : -8,
        duration: .24,
        ease: "power3.out",
        overwrite: true,
      });
      cleanup = () => motion.killTweensOf(slot);
    };
    void animate();
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onPreference = () => { cleanup?.(); void animate(); };
    preference.addEventListener("change", onPreference);
    return () => { disposed = true; cleanup?.(); preference.removeEventListener("change", onPreference); };
  }, [visible, mounted, width]);

  return (
    <div
      ref={slotRef}
      className={`wh-pill-slot ${visible ? "open" : "closing"}`}
      style={{ "--toolbar-width": `${width}px` } as CSSProperties}
      aria-hidden={!visible}
      inert={!visible}
    >
      {mounted && (
        <IslandSurface ref={pillRef}>{children}</IslandSurface>
      )}
    </div>
  );
}
