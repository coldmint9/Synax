import { useLayoutEffect, useRef, type HTMLAttributes } from "react";
import { createPortal } from "react-dom";

/** Keep custom dialogs outside zoomed/transformed workbench panels. */
export function DialogOverlay({
  children,
  className = "",
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const measure = () => {
      const element = ref.current;
      if (!element) return;
      element.style.setProperty(
        "--dialog-viewport-height",
        `${viewport.height}px`,
      );
      element.style.setProperty(
        "--dialog-viewport-width",
        `${viewport.width}px`,
      );
      element.style.setProperty(
        "--dialog-viewport-top",
        `${viewport.offsetTop}px`,
      );
      element.style.setProperty(
        "--dialog-viewport-left",
        `${viewport.offsetLeft}px`,
      );
    };
    measure();
    viewport.addEventListener("resize", measure);
    viewport.addEventListener("scroll", measure);
    return () => {
      viewport.removeEventListener("resize", measure);
      viewport.removeEventListener("scroll", measure);
    };
  }, []);
  return createPortal(
    <div ref={ref} className={`dialog-overlay ${className}`} {...props}>
      {children}
    </div>,
    document.body,
  );
}
