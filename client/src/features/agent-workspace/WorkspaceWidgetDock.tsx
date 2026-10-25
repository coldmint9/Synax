import { memo, useId, useState } from "react";
import { LayoutGrid, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useLocale } from "../../shared/hooks/useLocale";
import { SessionWorkspacePanel } from "./SessionWorkspacePanel";
import { WorkspaceWidgetManager } from "./WorkspaceWidgetManager";

/** Fixed action rail remains available when the widget viewport is collapsed. */
export const WorkspaceWidgetDock = memo(function WorkspaceWidgetDock({
  sessionId,
  scope,
  collapsed,
  onToggle,
}: {
  sessionId: string | null;
  scope: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const contentId = useId();
  const [layoutOpen, setLayoutOpen] = useState(false);
  const zh = useLocale().locale === "zh";
  const label = collapsed
    ? zh
      ? "展开工作组件"
      : "Expand work widgets"
    : zh
      ? "收起工作组件"
      : "Collapse work widgets";
  return (
    <div
      className="work-widget-dock"
      data-collapsed={collapsed ? "true" : undefined}
    >
      <div
        id={contentId}
        className="work-widget-content"
        aria-hidden={collapsed}
        inert={collapsed}
        style={{ opacity: collapsed ? 0 : 1 }}
      >
        <div className="work-widget-canvas">
          <SessionWorkspacePanel sessionId={sessionId} mode="dashboard" />
        </div>
      </div>
      <div
        className="work-widget-actions"
        role="toolbar"
        aria-label={zh ? "工作组件操作" : "Work widget actions"}
      >
        <button
          type="button"
          className="work-widget-toggle"
          onClick={onToggle}
          aria-label={label}
          title={label}
          aria-expanded={!collapsed}
          aria-controls={contentId}
        >
          {collapsed ? (
            <PanelRightOpen size={15} />
          ) : (
            <PanelRightClose size={15} />
          )}
        </button>
        {!collapsed && (
          <button
            type="button"
            className="work-widget-toggle"
            onClick={() => setLayoutOpen(true)}
            aria-label={zh ? "重新布局" : "Rearrange widgets"}
            title={zh ? "重新布局" : "Rearrange widgets"}
            aria-haspopup="dialog"
          >
            <LayoutGrid size={15} />
          </button>
        )}
      </div>
      <WorkspaceWidgetManager
        open={layoutOpen}
        onClose={() => setLayoutOpen(false)}
        scope={scope}
      />
    </div>
  );
});
