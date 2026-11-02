import clsx from "clsx";
import { useId, type ReactNode } from "react";
import { Menu, MenuAction, MenuButton, MenuItems } from "@/shared/ui/ui/Menu";
import { Tooltip } from "@/shared/ui/ui/Tooltip";
import { ToolbarBadge } from "./ToolbarBadge";
import type { ToolbarIcon } from "./toolbarNavItems";

export interface ToolbarMenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ToolbarIcon;
  /** Placeholder rows stay visible but never activate. */
  readonly disabled?: boolean;
  readonly onSelect?: () => void;
}

export interface ToolbarMenuProps {
  /** Accessible name of the trigger; the badge never changes it. */
  label: string;
  /** Extra description, e.g. the unread count, exposed through aria-describedby. */
  description?: string;
  icon?: ToolbarIcon;
  /** Custom trigger content, e.g. the account avatar. */
  trigger?: ReactNode;
  badgeDot?: boolean;
  badgeStatus?: string;
  header?: ReactNode;
  items: readonly ToolbarMenuItem[];
  className?: string;
  triggerClassName?: string;
}

/**
 * Trigger plus a menu panel. Headless UI owns dismissal, focus return and the
 * menu keyboard model, so this component only declares data and rendering.
 */
export function ToolbarMenu({
  label,
  description,
  icon: Icon,
  trigger,
  badgeDot = false,
  badgeStatus,
  header,
  items,
  className,
  triggerClassName,
}: ToolbarMenuProps) {
  const descriptionId = useId();
  const tooltip = description ? `${label} · ${description}` : label;
  return (
    <Menu className={clsx("wh-menu", className)}>
      <Tooltip content={tooltip}>
        <MenuButton
          type="button"
          className={clsx("wh-btn wh-menu-trigger", triggerClassName)}
          aria-label={label}
          aria-describedby={description ? descriptionId : undefined}
        >
          {trigger ?? (Icon ? <Icon size={16} aria-hidden="true" /> : null)}
          <ToolbarBadge
            dot={badgeDot}
            status={badgeStatus}
            className="wh-menu-trigger__badge"
          />
          {description ? (
            <span id={descriptionId} className="wh-sr-only">
              {description}
            </span>
          ) : null}
        </MenuButton>
      </Tooltip>
      <MenuItems className="wh-menu-panel">
        {header}
        {items.map((item) => {
          const ItemIcon = item.icon;
          return (
            <MenuAction
              key={item.id}
              className="wh-menu-item"
              disabled={item.disabled}
              onClick={item.onSelect}
            >
              {ItemIcon ? <ItemIcon size={14} aria-hidden="true" /> : null}
              <span>{item.label}</span>
            </MenuAction>
          );
        })}
      </MenuItems>
    </Menu>
  );
}
