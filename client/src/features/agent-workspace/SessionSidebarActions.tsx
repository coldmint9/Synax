import { Archive, FolderTree, PanelLeftClose, PanelLeftOpen, SquarePen } from "lucide-react";
import { Button } from "@/shared/ui/ui/Button";
import { Tooltip } from "@/shared/ui/ui/Tooltip";
import { useLocale } from "../../shared/hooks/useLocale";

export function SessionSidebarActions({
  collapsed, onTogglePanel, sidebarView, onSidebarViewChange,
  onNewSession, onClearInactive, archiving,
}: {
  collapsed: boolean;
  onTogglePanel?: () => void;
  sidebarView: "sessions" | "workspace";
  onSidebarViewChange?: (view: "sessions" | "workspace") => void;
  onNewSession?: () => void;
  onClearInactive: () => void;
  archiving: boolean;
}) {
  const { t } = useLocale();
  const workspace = sidebarView === "workspace";
  const toggleLabel = t(collapsed ? "appExpandSidebar" : "appCollapseSidebar");
  const viewLabel = t(workspace ? "sidebarSwitchToSessions" : "sidebarSwitchToWorkspace");

  return (
    <div className="workbench-header__sidebar-pill" role="group" aria-label={t("sidebarActions")}>
      <Tooltip content={toggleLabel}>
        <Button iconOnly variant="ghost" size="sm" className="wh-btn"
          aria-label={toggleLabel} aria-expanded={!collapsed} onClick={onTogglePanel}>
          {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
        </Button>
      </Tooltip>
      {onNewSession && <Tooltip content={t("sessionNewChat")}>
        <Button iconOnly variant="ghost" size="sm" className="wh-btn"
          aria-label={t("sessionNewChat")} onClick={onNewSession}>
          <SquarePen size={15} />
        </Button>
      </Tooltip>}
      {onSidebarViewChange && <Tooltip content={viewLabel}>
        <Button iconOnly variant="ghost" size="sm"
          className="wh-btn wh-view-btn"
          aria-label={viewLabel}
          aria-pressed={workspace}
          onClick={() => onSidebarViewChange(workspace ? "sessions" : "workspace")}>
          <FolderTree size={15} aria-hidden="true" />
        </Button>
      </Tooltip>}
      <Tooltip content={t("sessionClearInactive")}>
        <Button iconOnly variant="ghost" size="sm" className="wh-btn" disabled={archiving}
          aria-label={t("sessionClearInactive")} onClick={onClearInactive}>
          <Archive size={15} className={archiving ? "animate-pulse" : undefined} />
        </Button>
      </Tooltip>
    </div>
  );
}
