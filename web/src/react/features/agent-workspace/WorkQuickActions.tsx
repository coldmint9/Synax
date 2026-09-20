import { Button } from "@heroui/react";
import { PanelRight } from "lucide-react";
import { useLocale } from "../../../hooks/useLocale";

/** Floating affordances leave the transcript's top edge behind the glass pill. */
export function WorkQuickActions({
  showDetailsButton,
  onShowDetails,
}: {
  showDetailsButton: boolean;
  onShowDetails: () => void;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  if (!showDetailsButton) return null;
  return (
    <div className="work-quick-actions wh-pill">
      {showDetailsButton && (
        <Button
          size="sm"
          variant="ghost"
          isIconOnly
          className="work-details-trigger"
          onPress={onShowDetails}
          aria-label={zh ? "任务详情" : "Task details"}
        >
          <PanelRight size={13} />
        </Button>
      )}
    </div>
  );
}
