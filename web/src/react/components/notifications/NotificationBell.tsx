import { useEffect, useRef } from "react";
import { Bell } from "lucide-react";
import {
  Popover,
  PopoverButton,
  PopoverPanel,
} from "@/react/components/ui/Popover";
import { useNotificationStore } from "../../state/notificationStore";
import { NotificationPanel } from "./NotificationPanel";

export function NotificationBell() {
  const unreadCount = useNotificationStore((s) => s.unreadCount);

  return (
    <Popover>
      <PopoverButton aria-label="通知" className="wh-btn relative">
        <Bell size={14} />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-medium text-destructive-foreground">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </PopoverButton>
      <PopoverPanel
        anchor={{ to: "bottom", gap: 8, padding: 8 }}
        focus
        role="dialog"
        aria-label="通知"
      >
        <NotificationContent />
      </PopoverPanel>
    </Popover>
  );
}


function NotificationContent() {
  const content = useRef<HTMLDivElement>(null);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const count = useNotificationStore((s) => s.notifications.length);
  useEffect(() => {
    // Mark-all-read and Clear remove their own focused button. Keep keyboard
    // dismissal available without moving focus away from any surviving action.
    if (document.activeElement === document.body) content.current?.focus();
  }, [unreadCount, count]);
  return <div ref={content} tabIndex={-1} className="outline-none"><NotificationPanel /></div>;
}
