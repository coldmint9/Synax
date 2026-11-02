import { Goal } from "lucide-react";
import { Popover, PopoverButton } from "@/shared/ui/ui/Popover";
import { Tooltip } from "@/shared/ui/ui/Tooltip";
import { useLocale } from "../../../shared/hooks/useLocale";
import { GoalMonitorPanel } from "../../../features/agent-workspace/GoalMonitorPanel";
import { IslandPopoverPanel } from "../IslandOverlays";

export function GoalToolbar({ sessionId }: { sessionId: string | null }) {
  const { locale } = useLocale();
  const label = locale === "zh" ? "目标" : "Goal";
  if (!sessionId) return null;
  return (
    <Popover>
      {({ open }) => (
        <>
          <Tooltip content={label}>
            <PopoverButton className="wh-btn" aria-label={label}>
              <Goal size={16} aria-hidden="true" />
            </PopoverButton>
          </Tooltip>
          <IslandPopoverPanel open={open} focus className="goal-monitor-menu" aria-label={label}>
            <GoalMonitorPanel sessionId={sessionId} />
          </IslandPopoverPanel>
        </>
      )}
    </Popover>
  );
}
