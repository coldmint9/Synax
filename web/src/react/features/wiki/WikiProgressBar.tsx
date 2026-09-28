import { Progress } from "@/react/components/ui/Progress";

type WikiProgressBarProps = {
  "aria-label": string;
  done?: number;
  total?: number;
  value?: number;
  isIndeterminate?: boolean;
  color?: "accent" | "success" | "warning" | "danger";
  className?: string;
};

/** Shared progress semantics for both determinate and indeterminate wiki work. */
export default function WikiProgressBar({
  "aria-label": ariaLabel,
  done,
  total,
  value,
  isIndeterminate,
  color = "accent",
  className = "w-full",
}: WikiProgressBarProps) {
  const showCount = done != null && total != null && total > 0;
  const fillValue = isIndeterminate
    ? undefined
    : (value ??
      (showCount
        ? Math.min(100, Math.round((done / total) * 100))
        : undefined));

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      {showCount && (
        <span className="text-[10px] tabular-nums text-muted-foreground/70">
          {done}/{total}
        </span>
      )}
      <Progress
        aria-label={ariaLabel}
        value={fillValue ?? 0}
        indeterminate={isIndeterminate}
        tone={color}
        className="w-full"
      />
    </div>
  );
}
