import { Tooltip } from "@/shared/ui/ui/Tooltip";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useLocale } from "../../shared/hooks/useLocale";
import { SessionToolbarActionsContent } from "./SessionToolbarPortal";

/** Keep the widget toggle in the global header while the page owns its state. */
export function WorkQuickActions({
  expanded,
  onToggle,
  controlsId,
}: {
  expanded: boolean;
  onToggle: () => void;
  controlsId: string;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const label = expanded
    ? zh
      ? "收起工作组件"
      : "Collapse work widgets"
    : zh
      ? "展开工作组件"
      : "Expand work widgets";
  return (
    <SessionToolbarActionsContent>
      <Tooltip content={label}>
        <button
          type="button"
          className={`wh-btn ${expanded ? "active" : ""}`}
          onClick={onToggle}
          aria-label={label}
          aria-expanded={expanded}
          aria-controls={controlsId}
        >
          {expanded ? (
            <PanelRightClose size={16} aria-hidden="true" />
          ) : (
            <PanelRightOpen size={16} aria-hidden="true" />
          )}
        </button>
      </Tooltip>
    </SessionToolbarActionsContent>
  );
}
