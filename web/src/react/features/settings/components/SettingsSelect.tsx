import type { ReactNode } from "react";
import { AppSelect, type AppSelectOption } from "../../../components/AppSelect";

export interface SelectOption extends AppSelectOption {
  label: ReactNode;
}

interface SettingsSelectProps {
  label?: string;
  variant?: "primary" | "secondary";
  className?: string;
  fullWidth?: boolean;
  selectedKey: string | null;
  onSelectionChange: (key: string | null) => void;
  isDisabled?: boolean;
  disallowEmptySelection?: boolean;
  "aria-label"?: string;
  options: SelectOption[];
}

export function SettingsSelect({
  label,
  variant = "secondary",
  className,
  fullWidth,
  selectedKey,
  onSelectionChange,
  isDisabled,
  "aria-label": ariaLabel,
  options,
}: SettingsSelectProps) {
  return (
    <div className={className}>
      <AppSelect
        className="settings-select"
        popoverClassName="settings-select-popover"
        label={label}
        variant={variant}
        fullWidth={fullWidth}
        value={selectedKey}
        onChange={onSelectionChange}
        isDisabled={isDisabled}
        aria-label={ariaLabel ?? label}
        options={options}
      />
    </div>
  );
}
