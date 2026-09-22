import { Label, ListBox, Select } from "@heroui/react";
import type { Key, ReactNode } from "react";

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

/**
 * Shared HeroUI v3 single-value selector.
 *
 * Selection fields use Select/ListBox, while command menus should use
 * Dropdown. Geometry and interaction states intentionally come from HeroUI;
 * callers only control layout width and option content.
 */
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
      onChange={(key: Key | null) => onChange(key == null ? null : String(key))}
      isDisabled={isDisabled}
      fullWidth={fullWidth}
      variant={variant}
      className={["app-select", className].filter(Boolean).join(" ")}
      placeholder={placeholder}
      aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}
    >
      {label ? <Label>{label}</Label> : null}
      <Select.Trigger>
        {startContent}
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover className={popoverClassName}>
        <ListBox
          aria-label={
            ariaLabel ?? (typeof label === "string" ? label : "Options")
          }
        >
          {options.map((option) => (
            <ListBox.Item
              key={option.key}
              id={option.key}
              textValue={
                option.textValue ??
                (typeof option.label === "string" ? option.label : option.key)
              }
              isDisabled={option.isDisabled}
            >
              {option.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
