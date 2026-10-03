import {
  Checkbox as HeadlessCheckbox,
  Switch as HeadlessSwitch,
  type CheckboxProps as HeadlessCheckboxProps,
  type SwitchProps as HeadlessSwitchProps,
} from "@headlessui/react";
import clsx from "clsx";
import { Check, Minus } from "lucide-react";
import { forwardRef } from "react";

export type SwitchProps = Omit<
  HeadlessSwitchProps<"button">,
  "as" | "className" | "children"
> & {
  size?: "sm" | "md";
  className?: string;
};
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  function Switch({ size = "md", className, ...props }, ref) {
    return (
      <HeadlessSwitch
        {...props}
        ref={ref}
        className={clsx(
          "ui-switch group relative inline-flex shrink-0 cursor-pointer items-center rounded-full border border-border/70 bg-muted shadow-inner transition-colors",
          "data-checked:border-primary/40 data-checked:bg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
          size === "sm" ? "h-5 w-9" : "h-6 w-11",
          className,
        )}
      >
        <span
          aria-hidden="true"
          className={clsx(
            "pointer-events-none block translate-x-0.5 rounded-full bg-white shadow-sm transition-transform duration-150 motion-reduce:transition-none",
            size === "sm"
              ? "size-3.5 group-data-checked:translate-x-[18px]"
              : "size-[18px] group-data-checked:translate-x-[22px]",
          )}
        />
      </HeadlessSwitch>
    );
  },
);

export type CheckboxProps = Omit<
  HeadlessCheckboxProps<"button">,
  "as" | "className" | "children"
> & {
  className?: string;
};
export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(
  function Checkbox({ className, ...props }, ref) {
    return (
      <HeadlessCheckbox
        {...props}
        as="button"
        type="button"
        ref={ref}
        className={clsx(
          "ui-checkbox inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded border border-border bg-card text-primary-foreground shadow-inner transition-colors",
          "data-checked:border-primary data-checked:bg-primary data-indeterminate:border-primary data-indeterminate:bg-primary",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
          className,
        )}
      >
        {({ checked, indeterminate }) => (
          <span aria-hidden="true" className="contents">
            {indeterminate ? (
              <Minus size={12} strokeWidth={2.5} />
            ) : checked ? (
              <Check size={12} strokeWidth={2.5} />
            ) : null}
          </span>
        )}
      </HeadlessCheckbox>
    );
  },
);
