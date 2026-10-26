import { memo, useState } from "react";
import { LayoutGrid } from "lucide-react";
import { useLocale } from "../../shared/hooks/useLocale";
import { SessionWorkspacePanel } from "./SessionWorkspacePanel";
import { WorkspaceWidgetManager } from "./WorkspaceWidgetManager";

/** Card content and its layout tools; visibility is controlled from the header. */
export const WorkspaceWidgetDock = memo(function WorkspaceWidgetDock({
  sessionId,
  scope,
}: {
  sessionId: string | null;
  scope: string;
}) {
  const [layoutOpen, setLayoutOpen] = useState(false);
  const zh = useLocale().locale === "zh";
  return (
    <div className="work-widget-dock">
      <div className="work-widget-content">
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
          onClick={() => setLayoutOpen(true)}
          aria-label={zh ? "重新布局" : "Rearrange widgets"}
          title={zh ? "重新布局" : "Rearrange widgets"}
          aria-haspopup="dialog"
        >
          <LayoutGrid size={15} />
        </button>
      </div>
      <WorkspaceWidgetManager
        open={layoutOpen}
        onClose={() => setLayoutOpen(false)}
        scope={scope}
      />
    </div>
  );
});
