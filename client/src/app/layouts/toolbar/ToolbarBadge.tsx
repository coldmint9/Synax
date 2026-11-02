import clsx from "clsx";
import { forwardRef, memo, type HTMLAttributes } from "react";

export interface ToolbarBadgeProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "children" | "aria-hidden"> {
  /** Count badge value; ignored when it is not positive. */
  count?: number;
  /** Status dot instead of a number. */
  dot?: boolean;
  /** Rendered as data-status so CSS can pick the tone. */
  status?: string;
  /** Accent for progress, attention for work that needs the user. */
  tone?: "accent" | "attention";
}

/**
 * Purely visual: the owning control carries the accessible description, so the
 * badge never adds a second stop or a duplicated name for assistive tech.
 */
export const ToolbarBadge = memo(
  forwardRef<HTMLSpanElement, ToolbarBadgeProps>(function ToolbarBadge(
    { count = 0, dot = false, status, tone = "accent", className, ...props },
    ref,
  ) {
    if (!dot && count <= 0) return null;
    return (
      <span
        {...props}
        ref={ref}
        aria-hidden="true"
        data-status={status}
        className={clsx(
          "wh-badge",
          dot ? "wh-badge--dot" : "wh-badge--count",
          tone === "attention" && "wh-badge--attention",
          className,
        )}
      >
        {dot ? null : count > 99 ? "99+" : count}
      </span>
    );
  }),
);
