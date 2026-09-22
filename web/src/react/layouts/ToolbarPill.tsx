import {
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

/** Keep the slot mounted so both its width and its sibling's position can retract. */
export function ToolbarPill({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(visible);
  const pillRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

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

  useLayoutEffect(() => {
    const pill = pillRef.current;
    if (!pill) return;
    const measure = () => setWidth(pill.offsetWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pill);
    return () => observer.disconnect();
  }, [mounted]);

  return (
    <div
      className={`wh-pill-slot ${visible ? "open" : "closing"}`}
      style={{ "--toolbar-width": `${width}px` } as CSSProperties}
      aria-hidden={!visible}
      inert={!visible}
    >
      {mounted && (
        <div ref={pillRef} className="wh-pill">{children}</div>
      )}
    </div>
  );
}
