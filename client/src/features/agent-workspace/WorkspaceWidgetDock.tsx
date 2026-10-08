import { memo, useId, useState, type PointerEvent } from "react";
import { LayoutGrid, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useLocale } from "../../shared/hooks/useLocale";
import { SessionWorkspacePanel } from "./SessionWorkspacePanel";
import { WorkspaceWidgetManager } from "./WorkspaceWidgetManager";

/** Fixed action rail remains available when the widget viewport is collapsed. */
export const WorkspaceWidgetDock = memo(function WorkspaceWidgetDock({
  sessionId, scope, width, onResize, collapsed, onToggle, resizing = false,
}: {
  sessionId: string | null;
  scope: string;
  width: number;
  onResize: (event: PointerEvent<HTMLDivElement>) => void;
  collapsed: boolean;
  onToggle: () => void;
  resizing?: boolean;
}) {
  const contentId = useId();
  const [layoutOpen, setLayoutOpen] = useState(false);
  const zh = useLocale().locale === "zh";
  const label = collapsed
    ? (zh ? "展开工作组件" : "Expand work widgets")
    : (zh ? "收起工作组件" : "Collapse work widgets");
  return (
    <aside
      className="session-workspace-sidebar session-workspace-sidebar--dock relative shrink-0"
      style={{ width: collapsed ? 40 : width }}
      data-collapsed={collapsed ? "true" : undefined}
      data-resizing={resizing ? "true" : undefined}
    >
      <div id={contentId} className="work-widget-content" aria-hidden={collapsed} inert={collapsed} style={{ opacity: collapsed ? 0 : 1 }}>
        <div className="work-widget-canvas" style={{ width }}>
          <SessionWorkspacePanel sessionId={sessionId} mode="dashboard" />
        </div>
      </div>
      <div className="work-widget-actions" role="toolbar" aria-label={zh ? "工作组件操作" : "Work widget actions"}>
        <button type="button" className="work-widget-toggle" onClick={onToggle} aria-label={label} title={label} aria-expanded={!collapsed} aria-controls={contentId}>
          {collapsed ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
        </button>
        {!collapsed && <button
          type="button"
          className="work-widget-toggle"
          onClick={() => setLayoutOpen(true)}
          aria-label={zh ? "重新布局" : "Rearrange widgets"}
          title={zh ? "重新布局" : "Rearrange widgets"}
          aria-haspopup="dialog"
        >
          <LayoutGrid size={15} />
        </button>}
      </div>
      <WorkspaceWidgetManager open={layoutOpen} onClose={() => setLayoutOpen(false)} scope={scope} />
      {!collapsed && <div
        className="session-panel-resizer session-panel-resizer--right"
        onPointerDown={onResize}
        role="separator"
        aria-orientation="vertical"
      />}
    </aside>
  );
});
