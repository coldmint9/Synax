import { useLocale } from "../../../hooks/useLocale";
import { PixelLoader } from "./LoadingState";

export function ThinkingIndicator({ showLabel = true }: { showLabel?: boolean }) {
  const { t } = useLocale();
  const label = t("sessionPendingThinking");
  return (
    <div
      role="status"
      aria-label={label}
      className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground"
    >
      <PixelLoader variant="Thinking" />
      <span className={showLabel ? undefined : "sr-only"}>{label}</span>
    </div>
  );
}
