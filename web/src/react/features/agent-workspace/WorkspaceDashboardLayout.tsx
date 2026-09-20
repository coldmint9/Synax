import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { GripVertical, MoveDiagonal2, RotateCcw } from "lucide-react";
import { useLocale } from "../../../hooks/useLocale";
import {
  panelOrder,
  normalizePanelSize,
  useDashboardLayoutStore,
  type DashboardPanelSize,
} from "./state/dashboardLayoutStore";
import "./workspaceDashboardLayout.css";
import { useDashboardMinimumHeight } from "./useDashboardMinimumHeight";

interface PanelProps {
  id: string;
  label: string;
  children: ReactNode;
}
export function DashboardPanel({ children }: PanelProps) {
  return <>{children}</>;
}
function collectPanels(children: ReactNode): PanelProps[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement(child)) return [];
    if (child.type === Fragment)
      return collectPanels((child.props as { children: ReactNode }).children);
    return child.type === DashboardPanel ? [child.props as PanelProps] : [];
  });
}

function layoutStatus(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap((child) => {
    if (isValidElement(child) && child.type === Fragment)
      return layoutStatus((child.props as { children: ReactNode }).children);
    return isValidElement(child) && child.type === DashboardPanel
      ? []
      : [child];
  });
}

export function WorkspaceDashboardLayout({
  scope,
  children,
}: {
  scope: string;
  children: ReactNode;
}) {
  const zh = useLocale().locale === "zh";
  const layout = useDashboardLayoutStore((s) => s.layouts[scope]);
  const panels = collectPanels(children);
  const ids = panels.map((panel) => panel.id);
  const order = panelOrder(layout?.order ?? [], ids);
  const viewport = useRef<HTMLDivElement>(null);
  useDashboardMinimumHeight(viewport);
  const cleanup = useRef<(() => void) | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const [draft, setDraft] = useState<{
    id: string;
    size: DashboardPanelSize;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => () => cleanup.current?.(), [scope]);

  const beginDrag = (event: ReactPointerEvent, panel: PanelProps) => {
    if (event.button !== 0) return;
    event.preventDefault();
    cleanup.current?.();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const root = viewport.current!;
    let y = event.clientY;
    const startY = y;
    let target: { id: string; after: boolean } | null = null;
    let frame = 0;
    let active = false;
    const tick = () => {
      if (active) {
        const bounds = root.getBoundingClientRect();
        const scale = bounds.height / root.clientHeight || 1;
        if (y < bounds.top + 32) root.scrollTop -= 8 / scale;
        else if (y > bounds.bottom - 32) root.scrollTop += 8 / scale;
        const candidates = [
          ...root.querySelectorAll<HTMLElement>("[data-dashboard-panel]"),
        ].filter((el) => el.dataset.dashboardPanel !== panel.id);
        const closest = candidates.reduce<HTMLElement | null>((best, el) => {
          const rect = el.getBoundingClientRect();
          const b = best?.getBoundingClientRect();
          return !b ||
            Math.abs(y - rect.top - rect.height / 2) <
              Math.abs(y - b.top - b.height / 2)
            ? el
            : best;
        }, null);
        if (closest) {
          const rect = closest.getBoundingClientRect();
          target = {
            id: closest.dataset.dashboardPanel!,
            after: y > rect.top + rect.height / 2,
          };
          setDrop((previous) =>
            previous?.id === target?.id && previous?.after === target?.after
              ? previous
              : target,
          );
        }
      }
      frame = requestAnimationFrame(tick);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      y = e.clientY;
      if (!active && Math.abs(y - startY) > 4) {
        active = true;
        setDragging(panel.id);
      }
    };
    const release = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape);
      setDragging(null);
      setDrop(null);
      cleanup.current = null;
    };
    const cancel = () => release();
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        release();
      }
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      if (active && target) {
        useDashboardLayoutStore
          .getState()
          .move(scope, panel.id, target.id, target.after, ids);
        setAnnouncement(
          zh ? `${panel.label}位置已调整` : `${panel.label} moved`,
        );
      }
      release();
    };
    cleanup.current = release;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape);
    frame = requestAnimationFrame(tick);
  };
  const beginResize = (event: ReactPointerEvent, id: string) => {
    if (event.button !== 0) return;
    event.preventDefault();
    cleanup.current?.();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const panel = event.currentTarget.closest<HTMLElement>(
      "[data-dashboard-panel]",
    )!;
    const root = viewport.current!;
    const rect = panel.getBoundingClientRect();
    const scale = rect.width / panel.offsetWidth || 1;
    const availableWidth =
      root.clientWidth -
      parseFloat(getComputedStyle(root).paddingLeft) -
      parseFloat(getComputedStyle(root).paddingRight);
    const start = {
      x: event.clientX,
      y: event.clientY,
      width: panel.offsetWidth,
      height: panel.offsetHeight,
    };
    let size = { width: start.width / availableWidth, height: start.height };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      size = normalizePanelSize({
        width:
          Math.max(
            Math.min(220, availableWidth),
            start.width + (e.clientX - start.x) / scale,
          ) / availableWidth,
        height: start.height + (e.clientY - start.y) / scale,
      });
      setDraft({ id, size });
    };
    const release = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape);
      setDraft(null);
      cleanup.current = null;
    };
    const cancel = () => release();
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        release();
      }
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      useDashboardLayoutStore.getState().resize(scope, id, size);
      release();
    };
    cleanup.current = release;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape);
  };

  return (
    <div
      ref={viewport}
      className="workspace-dashboard workspace-dashboard--custom session-workspace-scroll min-h-0 flex-1"
      data-arranging={Boolean(dragging || draft)}
    >
      {layoutStatus(children)}
      {order.map((id) => {
        const panel = panels.find((item) => item.id === id)!;
        const size = draft?.id === id ? draft.size : layout?.sizes[id];
        return (
          <section
            key={id}
            data-dashboard-panel={id}
            data-dragging={dragging === id}
            data-sized={Boolean(size)}
            data-drop={
              drop?.id === id ? (drop.after ? "after" : "before") : undefined
            }
            className="dashboard-panel"
            style={{
              width: size ? `${size.width * 100}%` : undefined,
              height: size?.height,
            }}
          >
            <button
              type="button"
              className="dashboard-panel-grip"
              aria-label={
                zh ? `移动板块：${panel.label}` : `Move panel: ${panel.label}`
              }
              title={
                zh
                  ? "拖动排序，或按上下方向键移动"
                  : "Drag to reorder, or use the Up and Down arrow keys"
              }
              onPointerDown={(event) => beginDrag(event, panel)}
              onKeyDown={(event) => {
                const step =
                  event.key === "ArrowUp"
                    ? -1
                    : event.key === "ArrowDown"
                      ? 1
                      : 0;
                if (!step) return;
                event.preventDefault();
                const target = order[order.indexOf(id) + step];
                if (target) {
                  useDashboardLayoutStore
                    .getState()
                    .move(scope, id, target, step > 0, ids);
                  setAnnouncement(
                    zh ? `${panel.label}位置已调整` : `${panel.label} moved`,
                  );
                }
              }}
            >
              <GripVertical size={13} />
            </button>
            <div className="dashboard-panel-content">{panel.children}</div>
            <button
              type="button"
              className="dashboard-panel-resize"
              aria-label={
                zh
                  ? `调整板块宽高：${panel.label}`
                  : `Resize panel: ${panel.label}`
              }
              title={
                zh
                  ? "拖动调整宽高；双击恢复自动尺寸；方向键微调"
                  : "Drag to resize; double-click to reset; arrow keys to fine-tune"
              }
              onPointerDown={(event) => beginResize(event, id)}
              onDoubleClick={() =>
                useDashboardLayoutStore.getState().resize(scope, id, null)
              }
              onKeyDown={(event) => {
                if (event.key === "Home") {
                  event.preventDefault();
                  useDashboardLayoutStore.getState().resize(scope, id, null);
                  return;
                }
                if (
                  !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const el = event.currentTarget.closest<HTMLElement>(
                  "[data-dashboard-panel]",
                )!;
                const amount = event.shiftKey ? 40 : 12;
                useDashboardLayoutStore.getState().resize(scope, id, {
                  width:
                    (size?.width ?? 1) +
                    (event.key === "ArrowRight"
                      ? 0.05
                      : event.key === "ArrowLeft"
                        ? -0.05
                        : 0),
                  height:
                    el.offsetHeight +
                    (event.key === "ArrowDown"
                      ? amount
                      : event.key === "ArrowUp"
                        ? -amount
                        : 0),
                });
              }}
            >
              <MoveDiagonal2 size={12} />
            </button>
          </section>
        );
      })}
      <button
        type="button"
        className="dashboard-layout-reset"
        onClick={() => {
          cleanup.current?.();
          useDashboardLayoutStore.getState().reset(scope);
        }}
        title={zh ? "恢复默认顺序和尺寸" : "Restore default order and sizes"}
      >
        <RotateCcw size={12} />
        {zh ? "重置布局" : "Reset layout"}
      </button>
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
