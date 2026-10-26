import type { HTMLAttributes, ReactNode } from "react";
import "./statusIndicator.css";

export interface StatusIndicatorProps extends Omit<HTMLAttributes<HTMLElement>, "children" | "role"> {
  label: string;
  /** Only in-progress work receives the quiet text sweep. */
  active?: boolean;
  tone?: "neutral" | "success" | "warning" | "danger";
  /** Use inline inside text or a control; its slots must contain phrasing content. */
  inline?: boolean;
  icon?: ReactNode;
  meta?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Stable live-region copy, independent of countdowns and other metadata. */
  announcement?: string;
  announce?: boolean;
  role?: "status" | "alert";
}

/** Shared presentation for waiting, progress, recovery, and completed work.
 * Business-specific timers and state transitions stay with the caller.
 */
export function StatusIndicator({
  label,
  active = false,
  tone = "neutral",
  inline = false,
  icon,
  meta,
  description,
  children,
  announcement,
  announce = true,
  role = "status",
  className,
  ...props
}: StatusIndicatorProps) {
  const Root = inline ? "span" : "div";

  return (
    <Root
      {...props}
      className={`status-indicator${className ? ` ${className}` : ""}`}
      data-active={active}
      data-tone={tone}
      data-inline={inline}
    >
      {icon != null && <span className="status-indicator__icon" aria-hidden="true">{icon}</span>}
      <Root className="status-indicator__body">
        <span className="status-indicator__heading">
          <span
            className="status-indicator__status"
            role={announce ? role : undefined}
            aria-label={announce ? announcement ?? label : undefined}
            aria-live={announce ? role === "alert" ? "assertive" : "polite" : undefined}
            aria-atomic={announce ? true : undefined}
          >
            <span className="status-indicator__label" aria-hidden={announce && announcement != null ? true : undefined}>
              {label}
            </span>
            {announce && announcement != null && <span className="sr-only">{announcement}</span>}
          </span>
          {meta != null && <span className="status-indicator__meta">{meta}</span>}
        </span>
        {description != null && <Root className="status-indicator__description">{description}</Root>}
        {children != null && <Root className="status-indicator__details">{children}</Root>}
      </Root>
    </Root>
  );
}
