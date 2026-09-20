import {
  Component,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

type Placement = "conversation" | "viewer";
type Targets = Record<Placement, HTMLDivElement | null>;
const IslandContext = createContext<{
  targets: Targets;
  register: (placement: Placement, target: HTMLDivElement | null) => void;
}>({ targets: { conversation: null, viewer: null }, register: () => {} });

export function WorkbenchIslandProvider({ children }: { children: ReactNode }) {
  const [targets, setTargets] = useState<Targets>({
    conversation: null,
    viewer: null,
  });
  const register = useCallback(
    (placement: Placement, target: HTMLDivElement | null) => {
      setTargets((previous) =>
        previous[placement] === target
          ? previous
          : { ...previous, [placement]: target },
      );
    },
    [],
  );
  const value = useMemo(() => ({ targets, register }), [targets, register]);
  return (
    <IslandContext.Provider value={value}>{children}</IslandContext.Provider>
  );
}

export function WorkbenchIslandSlot({ placement }: { placement: Placement }) {
  const { register } = useContext(IslandContext);
  const attach = useCallback(
    (target: HTMLDivElement | null) => register(placement, target),
    [placement, register],
  );
  return (
    <div
      ref={attach}
      className={`workspace-island-slot workspace-island-slot--${placement}`}
    />
  );
}

interface TransitionProps {
  target: HTMLDivElement | null;
  compact: boolean;
  children: ReactNode;
}

/** Own one portal container so moving the controls never remounts their menus.
 * A pre-commit snapshot captures the expanded pill before its labels change.
 * Only the short move reads layout; no resize observer or animation loop runs
 * while the user is reading, scrolling or resizing the conversation. */
class IslandTransition extends Component<TransitionProps> {
  private mount = Object.assign(document.createElement("div"), {
    className: "workbench-island-mount",
  });
  private animation: Animation | undefined;
  private lastBounds: DOMRect | null = null;

  private pill() {
    return this.mount.querySelector<HTMLElement>(".wh-pill");
  }

  componentDidMount() {
    this.props.target?.appendChild(this.mount);
    this.lastBounds = this.pill()?.getBoundingClientRect() ?? null;
  }

  getSnapshotBeforeUpdate(previous: TransitionProps): DOMRect | null {
    if (
      previous.target === this.props.target &&
      previous.compact === this.props.compact
    )
      return null;
    const bounds = this.pill()?.getBoundingClientRect();
    return bounds?.width ? bounds : this.lastBounds;
  }

  componentDidUpdate(
    previous: TransitionProps,
    _state: unknown,
    previousBounds: DOMRect | null,
  ) {
    if (
      previous.target === this.props.target &&
      previous.compact === this.props.compact
    )
      return;
    this.animation?.cancel();
    this.animation = undefined;
    if (this.mount.parentNode !== this.props.target)
      this.props.target?.appendChild(this.mount);
    const pill = this.pill();
    if (!pill) return;
    const next = pill.getBoundingClientRect();
    this.lastBounds = next.width ? next : previousBounds;
    if (
      !previousBounds?.width ||
      !next.width ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const zoom = pill.offsetHeight ? next.height / pill.offsetHeight : 1;
    this.animation = pill.animate?.(
      [
        {
          transform: `translate(${(previousBounds.x - next.x) / zoom}px, ${(previousBounds.y - next.y) / zoom}px) scale(${previousBounds.width / next.width}, ${previousBounds.height / next.height})`,
        },
        { transform: "none" },
      ],
      { duration: 280, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
  }

  componentWillUnmount() {
    this.animation?.cancel();
    this.mount.remove();
  }

  render() {
    return createPortal(this.props.children, this.mount);
  }
}

export function WorkbenchIsland({
  placement,
  children,
}: {
  placement: Placement | "global";
  children: (compact: boolean) => ReactNode;
}) {
  const { targets } = useContext(IslandContext);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const target =
    placement === "global"
      ? anchor
      : (targets[placement] ?? targets.conversation ?? anchor);
  const compact =
    placement === "viewer" && target === targets.viewer && target !== null;
  return (
    <>
      <div ref={setAnchor} className="workbench-island-anchor" />
      <IslandTransition target={target} compact={compact}>
        {children(compact)}
      </IslandTransition>
    </>
  );
}
