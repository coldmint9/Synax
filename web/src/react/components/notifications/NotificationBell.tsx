import { Bell } from 'lucide-react'
import { Button, Popover } from '@heroui/react'
import { useNotificationStore } from '../../state/notificationStore'
import { NotificationPanel } from './NotificationPanel'

export function NotificationBell() {
  const unreadCount = useNotificationStore(s => s.unreadCount)

  return (
    <Popover>
      <Button isIconOnly variant="tertiary" size="sm" aria-label="通知" className="relative">
        <Bell size={15} />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-medium text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </Button>
      <Popover.Content placement="bottom" offset={8}>
        <Popover.Dialog>
          <Popover.Arrow />
          <NotificationPanel />
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  )
}
