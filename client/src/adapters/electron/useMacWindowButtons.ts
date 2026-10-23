import { useLayoutEffect, useRef } from "react";

type WindowButtonsApi = {
  platform?: string;
  alignWindowButtons?: (centerY: number) => Promise<boolean>;
};

/** Align native traffic lights with the first toolbar row, including CSS zoom. */
export function useMacWindowButtons() {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const api = (window as Window & { electronAPI?: WindowButtonsApi }).electronAPI;
    const element = ref.current;
    if (api?.platform !== "darwin" || !api.alignWindowButtons || !element) return;

    let frame = 0;
    let lastCenter = -1;
    const sync = () => {
      const rect = element.getBoundingClientRect();
      if (rect.height <= 0) return;
      const center = rect.top + rect.height / 2;
      if (center === lastCenter) return;
      lastCenter = center;
      void api.alignWindowButtons!(center).catch(() => undefined);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(sync);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    // CSS zoom changes screen geometry without changing the observed box size.
    const preferences = new MutationObserver(schedule);
    preferences.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    window.addEventListener("resize", schedule);
    sync();
    return () => {
      resize.disconnect();
      preferences.disconnect();
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
    };
  }, []);

  return ref;
}
