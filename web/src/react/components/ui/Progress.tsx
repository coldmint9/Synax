import clsx from "clsx";
import type { HTMLAttributes } from "react";

const fills = {
  accent: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
};
export type ProgressProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  value?: number;
  min?: number;
  max?: number;
  indeterminate?: boolean;
  tone?: keyof typeof fills;
};
export function Progress({
  value = 0,
  min = 0,
  max = 100,
  indeterminate = false,
  tone = "accent",
  className,
  ...props
}: ProgressProps) {
  const lower = Number.isFinite(min) ? min : 0;
  const upper = Number.isFinite(max) && max > lower ? max : lower + 100;
  const current = Math.min(
    upper,
    Math.max(lower, Number.isFinite(value) ? value : lower),
  );
  const percentage = ((current - lower) / (upper - lower)) * 100;
  return (
    <div
      {...props}
      role="progressbar"
      aria-valuemin={lower}
      aria-valuemax={upper}
      aria-valuenow={indeterminate ? undefined : current}
      className={clsx(
        "h-1.5 w-full overflow-hidden rounded-full bg-muted",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className={clsx(
          "h-full rounded-full transition-[width] motion-reduce:transition-none",
          fills[tone],
          indeterminate && "motion-safe:animate-pulse",
        )}
        style={{ width: indeterminate ? "40%" : `${percentage}%` }}
      />
    </div>
  );
}
