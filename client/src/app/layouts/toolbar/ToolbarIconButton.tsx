import clsx from "clsx";
import { memo } from "react";
import { Tooltip } from "@/shared/ui/ui/Tooltip";
import type { ToolbarIcon } from "./toolbarNavItems";

export interface ToolbarIconButtonProps {
  icon: ToolbarIcon;
  label: string;
  onClick: () => void;
  /** Toolbar toggles announce their state; omit for plain commands. */
  pressed?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * One icon control for the action cluster. The handler is owned by the caller so
 * this component stays a memoized leaf and never re-renders on store churn.
 */
export const ToolbarIconButton = memo(function ToolbarIconButton({
  icon: Icon,
  label,
  onClick,
  pressed,
  disabled = false,
  className,
}: ToolbarIconButtonProps) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className={clsx("wh-btn", pressed && "active", className)}
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
      >
        <Icon size={16} aria-hidden="true" />
      </button>
    </Tooltip>
  );
});
