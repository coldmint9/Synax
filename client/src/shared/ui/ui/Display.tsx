import clsx from "clsx";
import { createElement, forwardRef, type HTMLAttributes } from "react";

export type Tone =
  | "default"
  | "accent"
  | "primary"
  | "success"
  | "warning"
  | "danger";
const tones: Record<Tone, string> = {
  default: "bg-muted text-muted-foreground",
  accent: "bg-primary/12 text-primary",
  primary: "bg-primary/12 text-primary",
  success: "bg-success/12 text-success",
  warning: "bg-warning/12 text-warning",
  danger: "bg-destructive/12 text-destructive",
};

export function Badge({
  size = "md",
  tone = "default",
  variant = "soft",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  size?: "sm" | "md";
  tone?: Tone;
  variant?: "soft" | "secondary";
}) {
  return (
    <span
      {...props}
      className={clsx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-md font-medium",
        size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs",
        tones[tone],
        variant === "secondary" && "ring-1 ring-inset ring-current/15",
        className,
      )}
    />
  );
}
export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      {...props}
      className={clsx(
        "min-w-0 rounded-xl border border-border/60 bg-card text-card-foreground",
        className,
      )}
    />
  );
}
export function Surface({
  className,
  tone = "default",
  ...props
}: HTMLAttributes<HTMLDivElement> & { tone?: "default" | "muted" }) {
  return (
    <div
      {...props}
      className={clsx(
        tone === "muted" ? "bg-muted" : "bg-background",
        "text-foreground",
        className,
      )}
    />
  );
}
export const ScrollArea = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function ScrollArea({ className, ...props }, ref) {
  return (
    <div
      {...props}
      ref={ref}
      className={clsx("min-h-0 overflow-auto overscroll-contain", className)}
    />
  );
});
export function Separator({
  orientation = "horizontal",
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  orientation?: "horizontal" | "vertical";
}) {
  return (
    <div
      {...props}
      role="separator"
      aria-orientation={orientation}
      className={clsx(
        "shrink-0 bg-border",
        orientation === "vertical" ? "h-full w-px" : "h-px w-full",
        className,
      )}
    />
  );
}
export function MenuHeading({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={clsx(
        "px-2 py-1 text-[11px] font-medium text-muted-foreground",
        className,
      )}
    />
  );
}
export function Skeleton({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...props}
      aria-hidden="true"
      className={clsx(
        "block rounded-md bg-muted motion-safe:animate-pulse",
        className,
      )}
    />
  );
}
export function Spinner({
  size = "md",
  color = "current",
  className,
  "aria-label": label = "Loading",
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  size?: "sm" | "md" | "lg";
  color?: "current";
}) {
  return (
    <span
      {...props}
      role="status"
      aria-label={label}
      className={clsx(
        "inline-block shrink-0 rounded-full border-2 border-current border-r-transparent motion-safe:animate-spin",
        size === "sm" ? "size-3" : size === "lg" ? "size-6" : "size-4",
        className,
      )}
    />
  );
}

type TextVariant = "body" | "body-sm" | "body-xs" | "h4" | "h5" | "h6";
const textClasses: Record<TextVariant, string> = {
  body: "text-sm leading-relaxed",
  "body-sm": "text-[13px] leading-relaxed",
  "body-xs": "text-xs leading-relaxed",
  h4: "text-xl font-semibold",
  h5: "text-lg font-semibold",
  h6: "text-sm font-semibold",
};
export function Text({
  variant = "body",
  color,
  className,
  ...props
}: HTMLAttributes<HTMLElement> & { variant?: TextVariant; color?: "muted" }) {
  const tag =
    variant === "h4" || variant === "h5" || variant === "h6" ? variant : "p";
  return createElement(tag, {
    ...props,
    className: clsx(
      textClasses[variant],
      color === "muted" ? "text-muted-foreground" : "text-foreground",
      className,
    ),
  });
}
