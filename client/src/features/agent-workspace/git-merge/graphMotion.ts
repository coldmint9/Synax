import { useEffect, useRef, useState } from "react";
interface Entry {
  visible: boolean;
  running: boolean;
  notify: (running: boolean) => void;
}
const entries = new Map<Element, Entry>();
let observer: IntersectionObserver | null = null;
let preference: MediaQueryList | null = null;
function update() {
  for (const entry of entries.values()) {
    const running =
      entry.visible &&
      document.visibilityState !== "hidden" &&
      !preference?.matches;
    if (entry.running !== running) {
      entry.running = running;
      entry.notify(running);
    }
  }
}
/** One observer and two global listeners for all pending graph instances. No RAF loop. */
function subscribe(element: Element, notify: Entry["notify"]) {
  if (!entries.size) {
    preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    preference.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    if (typeof IntersectionObserver !== "undefined")
      observer = new IntersectionObserver(
        (changes) => {
          for (const change of changes) {
            const entry = entries.get(change.target);
            if (entry) entry.visible = change.isIntersecting;
          }
          update();
        },
        { threshold: 0.01 },
      );
  }
  entries.set(element, { visible: !observer, running: false, notify });
  observer?.observe(element);
  update();
  return () => {
    observer?.unobserve(element);
    entries.delete(element);
    if (!entries.size) {
      observer?.disconnect();
      observer = null;
      preference?.removeEventListener("change", update);
      preference = null;
      document.removeEventListener("visibilitychange", update);
    }
  };
}
export function useGraphMotion(enabled: boolean) {
  const ref = useRef<HTMLElement>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    setRunning(false);
    if (!enabled || !ref.current) return;
    return subscribe(ref.current, setRunning);
  }, [enabled]);
  return { ref, running: enabled && running };
}
