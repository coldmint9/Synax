import {
  Activity,
  useId,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useLocale } from "../../shared/hooks/useLocale";
import "./sessionSidePanel.css";

/** A view supplies content and its own layout; the host knows no feature types. */
export interface SessionSidePanelView {
  id: string;
  label: string;
  content: ReactNode;
  width: number;
  presentation?: "inset" | "flush";
  collapsed?: boolean;
  fullscreen?: boolean;
  resizing?: boolean;
  onResize: (event: PointerEvent<HTMLDivElement>) => void;
  onResizeKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

export function SessionSidePanel({
  views,
  activeViewId,
  minWidth,
  maxWidth,
}: {
  views: SessionSidePanelView[];
  activeViewId: string | null;
  minWidth: number;
  maxWidth: number;
}) {
  const contentId = useId();
  const zh = useLocale().locale === "zh";
  const active = views.find((view) => view.id === activeViewId);
  const fullscreen = Boolean(active?.fullscreen);
  const collapsed = Boolean(active?.collapsed);

  return (
    <aside
      className="session-side-panel"
      hidden={!active}
      aria-label={active?.label}
      data-view={active?.id}
      data-presentation={active?.presentation ?? "flush"}
      data-collapsed={collapsed ? "true" : undefined}
      data-fullscreen={fullscreen ? "true" : undefined}
      data-resizing={active?.resizing ? "true" : undefined}
      style={
        active && !fullscreen
          ? { width: collapsed ? 40 : active.width }
          : undefined
      }
    >
      <div id={contentId} className="session-side-panel-content">
        {views.map((view) => (
          <Activity
            key={view.id}
            mode={view.id === activeViewId ? "visible" : "hidden"}
          >
            <div
              className="session-side-panel-view"
              style={
                {
                  "--side-panel-content-width": `${view.width - (view.presentation === "inset" ? 6 : 0)}px`,
                } as CSSProperties
              }
            >
              {view.content}
            </div>
          </Activity>
        ))}
      </div>
      {active && !collapsed && !fullscreen ? (
        <div
          className="session-panel-resizer session-panel-resizer--right"
          onPointerDown={active.onResize}
          onKeyDown={active.onResizeKeyDown}
          tabIndex={0}
          role="separator"
          aria-label={zh ? `调整${active.label}宽度` : `Resize ${active.label}`}
          aria-controls={contentId}
          aria-orientation="vertical"
          aria-valuemin={minWidth}
          aria-valuemax={maxWidth}
          aria-valuenow={active.width}
        />
      ) : null}
    </aside>
  );
}
