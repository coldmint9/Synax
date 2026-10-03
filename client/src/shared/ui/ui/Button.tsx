import {
  Button as HeadlessButton,
  useClose,
  type ButtonProps as HeadlessButtonProps,
} from "@headlessui/react";
import clsx from "clsx";
import { forwardRef, type ReactNode } from "react";

export type ControlSize = "xs" | "sm" | "md" | "lg";
export type ButtonVariant =
  | "primary"
  | "secondary"
  | "tertiary"
  | "ghost"
  | "outline"
  | "danger"
  | "danger-soft";
export interface ButtonState {
  pending: boolean;
}
export type ButtonProps = Omit<
  HeadlessButtonProps<"button">,
  "as" | "className" | "children"
> & {
  variant?: ButtonVariant;
  size?: ControlSize;
  pending?: boolean;
  iconOnly?: boolean;
  className?: string;
  children?: ReactNode | ((state: ButtonState) => ReactNode);
};

const variants: Record<ButtonVariant, string> = {
  primary:
    "border-primary/40 bg-primary text-primary-foreground shadow-sm enabled:hover:brightness-105",
  secondary:
    "border-border/70 bg-card text-card-foreground shadow-sm enabled:hover:bg-muted",
  tertiary:
    "border-transparent bg-muted/70 text-foreground enabled:hover:bg-muted",
  ghost:
    "border-transparent bg-transparent text-foreground enabled:hover:bg-muted",
  outline:
    "border-border bg-transparent text-foreground enabled:hover:bg-muted",
  danger:
    "border-destructive/40 bg-destructive text-destructive-foreground shadow-sm enabled:hover:brightness-105",
  "danger-soft":
    "border-destructive/15 bg-destructive/10 text-destructive enabled:hover:bg-destructive/15",
};
const sizes: Record<ControlSize, string> = {
  xs: "h-6 gap-1 px-2 text-[11px]",
  sm: "h-7 gap-1.5 px-2.5 text-xs",
  md: "h-8 gap-1.5 px-3 text-[13px]",
  lg: "h-10 gap-2 px-4 text-sm",
};
const iconSizes: Record<ControlSize, string> = {
  xs: "w-6 !px-0",
  sm: "w-7 !px-0",
  md: "w-8 !px-0",
  lg: "w-10 !px-0",
};

/** Native button contract; interaction, keyboard and focus state are owned by Headless UI. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      children,
      className,
      variant = "secondary",
      size = "md",
      iconOnly = false,
      pending = false,
      disabled = false,
      type = "button",
      ...props
    },
    ref,
  ) {
    const renderContent = typeof children === "function";
    return (
      <HeadlessButton
        {...props}
        ref={ref}
        type={type}
        disabled={disabled || pending}
        aria-busy={pending || undefined}
        className={clsx(
          "ui-button inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-lg border font-medium transition-[background-color,box-shadow,transform] duration-150",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 enabled:active:translate-y-px motion-reduce:transition-none",
          variants[variant],
          sizes[size],
          iconOnly && iconSizes[size],
          className,
        )}
      >
        {pending && !renderContent ? (
          <span
            aria-hidden="true"
            className="size-3 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none"
          />
        ) : null}
        {renderContent ? children({ pending }) : children}
      </HeadlessButton>
    );
  },
);

/** Explicit dialog/popover close action, rather than a hidden slot convention. */
export const CloseButton = forwardRef<HTMLButtonElement, ButtonProps>(
  function CloseButton(props, ref) {
    const close = useClose();
    return (
      <Button
        {...props}
        ref={ref}
        onClick={(event) => {
          props.onClick?.(event);
          if (!event.defaultPrevented) close();
        }}
      />
    );
  },
);
