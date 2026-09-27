import { useLocale } from "../../../hooks/useLocale";
import { PixelLoader } from "./LoadingState";

export function ThinkingIndicator({
  showLabel = true,
  label: customLabel,
}: {
  showLabel?: boolean;
  label?: string;
}) {
  const { t } = useLocale();
  const label = customLabel ?? t("sessionPendingThinking");
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
