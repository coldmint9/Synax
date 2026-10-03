import { Select } from "@/shared/ui/ui/Select";
import type { ReactNode } from "react";

export interface AppSelectOption {
  key: string;
  label: ReactNode;
  textValue?: string;
  isDisabled?: boolean;
}

export interface AppSelectProps {
  value: string | null;
  onChange: (value: string | null) => void;
  options: AppSelectOption[];
  label?: ReactNode;
  "aria-label"?: string;
  placeholder?: string;
  isDisabled?: boolean;
  className?: string;
  fullWidth?: boolean;
  variant?: "primary" | "secondary";
  startContent?: ReactNode;
  popoverClassName?: string;
}

/** App-level option naming adapter; selection and keyboard interaction use Headless UI. */
export function AppSelect({
  value,
  onChange,
  options,
  label,
  "aria-label": ariaLabel,
  placeholder,
  isDisabled,
  className,
  fullWidth = true,
  variant = "secondary",
  startContent,
  popoverClassName,
}: AppSelectProps) {
  return (
    <Select
      value={value}
      onChange={onChange}
      options={options.map((option) => ({
        value: option.key,
        label: option.label,
        textValue: option.textValue,
        disabled: option.isDisabled,
      }))}
      label={label}
      aria-label={ariaLabel}
      placeholder={placeholder}
      disabled={isDisabled}
      className={["app-select", fullWidth ? "w-full" : "w-auto", className]
        .filter(Boolean)
        .join(" ")}
      leading={startContent}
      optionsClassName={popoverClassName}
      triggerClassName={
        variant === "primary" ? "bg-primary text-primary-foreground" : undefined
      }
    />
  );
}
