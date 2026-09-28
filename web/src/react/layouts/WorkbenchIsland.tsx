import { loadMotion, reducedMotion } from "../design/motion";
import type { gsap } from "gsap";
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

interface TransitionSnapshot {
  bounds: DOMRect | null;
  focused: HTMLElement | null;
}

/** Own one portal container so moving the controls never remounts their menus.
 * A pre-commit snapshot captures the expanded pill before its labels change.
 * Only the short move reads layout; no resize observer or animation loop runs
 * while the user is reading, scrolling or resizing the conversation. */
class IslandTransition extends Component<TransitionProps> {
  private mount = Object.assign(document.createElement("div"), {
    className: "workbench-island-mount",
  });
  private animation: gsap.core.Tween | undefined;
  private animationEpoch = 0;
  private lastBounds: DOMRect | null = null;

  private pill() {
    return this.mount.querySelector<HTMLElement>(".wh-pill");
  }

  componentDidMount() {
    this.props.target?.appendChild(this.mount);
    this.lastBounds = this.pill()?.getBoundingClientRect() ?? null;
    if (!reducedMotion()) void loadMotion().catch(() => {});
  }

  getSnapshotBeforeUpdate(previous: TransitionProps): TransitionSnapshot | null {
    if (
      previous.target === this.props.target &&
      previous.compact === this.props.compact
    )
      return null;
    const bounds = this.pill()?.getBoundingClientRect();
    const active = this.mount.ownerDocument.activeElement;
    return {
      bounds: bounds?.width ? bounds : this.lastBounds,
      focused:
        active instanceof HTMLElement && this.mount.contains(active)
          ? active
          : null,
    };
  }

  componentDidUpdate(
    previous: TransitionProps,
    _state: unknown,
    snapshot: TransitionSnapshot | null,
  ) {
    if (
      previous.target === this.props.target &&
      previous.compact === this.props.compact
    )
      return;
    this.animationEpoch++;
    this.animation?.kill();
    this.pill()?.style.removeProperty("transform");
    this.pill()?.style.removeProperty("transform-origin");
    this.animation = undefined;
    if (this.props.target && this.mount.parentNode !== this.props.target) {
      const ownerDocument = this.mount.ownerDocument;
      const active = ownerDocument.activeElement;
      // Prefer the actual focused descendant; the old slot may already have
      // been removed in this commit, in which case the snapshot preserves it.
      const focused =
        active instanceof HTMLElement && this.mount.contains(active)
          ? active
          : active === ownerDocument.body
            ? snapshot?.focused
            : null;
      this.props.target.appendChild(this.mount);
      if (
        focused?.isConnected &&
        this.mount.contains(focused) &&
        (ownerDocument.activeElement === focused ||
          ownerDocument.activeElement === ownerDocument.body)
      ) {
        focused.focus({ preventScroll: true });
      }
    }
    const previousBounds = snapshot?.bounds ?? null;
    const pill = this.pill();
    if (!pill) return;
    const next = pill.getBoundingClientRect();
    this.lastBounds = next.width ? next : previousBounds;
    if (
      !previousBounds?.width ||
      !next.width ||
      reducedMotion()
    )
      return;
    const zoom = pill.offsetHeight ? next.height / pill.offsetHeight : 1;
    const epoch = ++this.animationEpoch;
    const x = (previousBounds.x - next.x) / zoom;
    const y = (previousBounds.y - next.y) / zoom;
    const scaleX = previousBounds.width / next.width;
    const scaleY = previousBounds.height / next.height;
    void loadMotion().then((motion) => {
      if (epoch !== this.animationEpoch || !pill.isConnected || reducedMotion()) return;
      this.animation = motion.fromTo(pill,
        { x, y, scaleX, scaleY, transformOrigin: "top left" },
        { x: 0, y: 0, scaleX: 1, scaleY: 1, duration: .24, ease: "power3.out", clearProps: "transform,transformOrigin", overwrite: true },
      );
    }).catch(() => { /* Layout and focus already use the final static position. */ });
  }

  componentWillUnmount() {
    this.animationEpoch++;
    this.animation?.kill();
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
