import { useCallback, useEffect, useRef, useState } from "react";

export const MAIN_CONTENT_MIN = 320;
type PanelSide = "left" | "right";

function readPanelWidth(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof window === "undefined") return fallback;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return fallback;
  }
  // `Number(null)` is 0, which used to pin first-load panels to their minimum
  // width instead of the default. Only a real, non-empty value wins.
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

export function useResizablePanel(
  side: PanelSide,
  defaultWidth: number,
  min: number,
  max: number,
  storageKey: string,
) {
  const [width, setWidth] = useState(() =>
    readPanelWidth(storageKey, defaultWidth, min, max),
  );
  const [collapsed, setCollapsed] = useState(false);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{
    startX: number;
    startWidth: number;
    scale: number;
  } | null>(null);

  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (collapsed && side === "left") return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      cleanupRef.current?.();
      setResizing(true);
      const panel = event.currentTarget.parentElement!;
      const scale =
        panel.getBoundingClientRect().width / panel.offsetWidth || 1;
      const startWidth = panel.offsetWidth || width;
      dragRef.current = { startX: event.clientX, startWidth, scale };
      const resizeMax =
        side === "right"
          ? Math.min(
              max,
              Math.max(
                min,
                (panel.parentElement?.clientWidth ?? max + MAIN_CONTENT_MIN) -
                  MAIN_CONTENT_MIN,
              ),
            )
          : max;
      let nextWidth = startWidth;
      let frame = 0;

      const handleMove = (move: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const delta =
          side === "left"
            ? move.clientX - drag.startX
            : drag.startX - move.clientX;
        nextWidth = Math.min(
          resizeMax,
          Math.max(min, drag.startWidth + delta / drag.scale),
        );
        if (!frame)
          frame = requestAnimationFrame(() => {
            frame = 0;
            setWidth(nextWidth);
          });
      };
      const handleUp = () => {
        if (frame) cancelAnimationFrame(frame);
        setWidth(nextWidth);
        try {
          window.localStorage.setItem(storageKey, String(nextWidth));
        } catch {
          /* storage may be unavailable */
        }
        dragRef.current = null;
        setResizing(false);
        cleanupRef.current = null;
        window.removeEventListener("pointercancel", handleUp);
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
      };
      cleanupRef.current = handleUp;
      window.addEventListener("pointercancel", handleUp);
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    },
    [collapsed, max, min, side, width, storageKey],
  );

  const resizeWithKeyboard = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const direction =
        event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (!direction && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      const panel = event.currentTarget.parentElement!;
      const resizeMax =
        side === "right"
          ? Math.min(
              max,
              Math.max(
                min,
                (panel.parentElement?.clientWidth ?? max + MAIN_CONTENT_MIN) -
                  MAIN_CONTENT_MIN,
              ),
            )
          : max;
      const currentWidth = panel.offsetWidth || width;
      const nextWidth =
        event.key === "Home"
          ? min
          : event.key === "End"
            ? resizeMax
            : Math.min(
                resizeMax,
                Math.max(
                  min,
                  currentWidth + direction * (side === "right" ? -20 : 20),
                ),
              );
      setWidth(nextWidth);
      try {
        window.localStorage.setItem(storageKey, String(nextWidth));
      } catch {
        /* Session-only width. */
      }
    },
    [max, min, side, storageKey, width],
  );

  return {
    width,
    collapsed,
    resizing,
    setCollapsed,
    startResize,
    resizeWithKeyboard,
  };
}
