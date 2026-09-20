import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const IslandDockContext = createContext<{
  target: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
}>({ target: null, setTarget: () => {} });

export function WorkbenchIslandProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return (
    <IslandDockContext.Provider value={{ target, setTarget }}>
      {children}
    </IslandDockContext.Provider>
  );
}

export function WorkbenchIslandSlot() {
  const { setTarget } = useContext(IslandDockContext);
  return <div ref={setTarget} className="workspace-island-slot" />;
}

/** Keep one mounted set of controls as the island moves between its two homes. */
export function WorkbenchIsland({
  enabled,
  children,
}: {
  enabled: boolean;
  children: (docked: boolean) => ReactNode;
}) {
  const { target } = useContext(IslandDockContext);
  const dockTarget = enabled ? target : null;
  const floatingAnchor = useRef<HTMLDivElement>(null);
  const [mount] = useState(() => document.createElement("div"));
  const previousBounds = useRef<DOMRect | null>(null);

  useLayoutEffect(() => {
    const destination = dockTarget ?? floatingAnchor.current;
    if (!destination) return;
    mount.className = "workbench-island-mount";
    destination.appendChild(mount);
    const pill = mount.querySelector<HTMLElement>(".wh-pill");
    if (!pill) return;

    const next = pill.getBoundingClientRect();
    const previous = previousBounds.current;
    let animation: Animation | undefined;
    if (
      previous?.width &&
      next.width &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      animation = pill.animate?.(
        [
          {
            transform: `translate(${previous.x - next.x}px, ${previous.y - next.y}px) scale(${previous.width / next.width}, ${previous.height / next.height})`,
          },
          { transform: "none" },
        ],
        {
          duration: 320,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        },
      );
    }
    previousBounds.current = next;
    const rememberBounds = () => {
      if (animation?.playState === "running") return;
      const bounds = pill.getBoundingClientRect();
      if (bounds.width) previousBounds.current = bounds;
    };
    const observer = new ResizeObserver(rememberBounds);
    observer.observe(pill);
    const panel = destination.closest(".work-conversation, .workbench-shell");
    if (panel) observer.observe(panel);
    animation?.addEventListener("finish", rememberBounds);
    return () => {
      // Capture the current frame so a quick reversal continues smoothly.
      const current = pill.getBoundingClientRect();
      // Closing the viewer can detach its slot before this effect cleans up.
      if (animation?.playState === "running" && current.width)
        previousBounds.current = current;
      observer.disconnect();
      animation?.removeEventListener("finish", rememberBounds);
      animation?.cancel();
    };
  }, [dockTarget, mount]);

  useLayoutEffect(() => () => mount.remove(), [mount]);

  return (
    <>
      <div ref={floatingAnchor} className="workbench-island-anchor" />
      {createPortal(children(Boolean(dockTarget)), mount)}
    </>
  );
}
