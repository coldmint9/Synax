import clsx from "clsx";
import { forwardRef } from "react";
import { Button, type ButtonProps } from "./Button";
import { LiquidGlassSurface } from "./LiquidGlassSurface";
import "./GlassButton.css";

export type GlassButtonProps = ButtonProps & {
  /** Flex/grid placement belongs on the surface; className stays on the button. */
  surfaceClassName?: string;
};

/** An opt-in optical accent; Button still owns every native interaction. */
export const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(
  function GlassButton(
    {
      className,
      surfaceClassName,
      variant = "secondary",
      disabled = false,
      pending = false,
      ...props
    },
    ref,
  ) {
    return (
      <LiquidGlassSurface
        className={clsx(
          "glass-button-surface",
          `glass-button-surface--${variant}`,
          surfaceClassName,
        )}
        intensity={variant === "primary" || variant === "danger" ? "strong" : "subtle"}
        interactive={!disabled && !pending}
      >
        <Button
          {...props}
          ref={ref}
          variant={variant}
          disabled={disabled}
          pending={pending}
          className={clsx("glass-button", `glass-button--${variant}`, className)}
        />
      </LiquidGlassSurface>
    );
  },
);
