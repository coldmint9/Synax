import {
  Field,
  Label,
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
} from "@headlessui/react";
import clsx from "clsx";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

export interface SelectOption<T extends string = string> {
  value: T;
  label: ReactNode;
  textValue?: string;
  disabled?: boolean;
}
export interface SelectProps<T extends string = string> {
  value: T | null;
  onChange: (value: T | null) => void;
  options: readonly SelectOption<T>[];
  label?: ReactNode;
  "aria-label"?: string;
  placeholder?: string;
  disabled?: boolean;
  name?: string;
  className?: string;
  triggerClassName?: string;
  optionsClassName?: string;
  leading?: ReactNode;
}

/** A single typed selection value; option semantics and keyboard behavior are Headless UI's. */
export function Select<T extends string = string>({
  value,
  onChange,
  options,
  label,
  "aria-label": ariaLabel,
  placeholder = "Select…",
  disabled,
  name,
  className,
  triggerClassName,
  optionsClassName,
  leading,
}: SelectProps<T>) {
  const selected = options.find((option) => option.value === value);
  return (
    <Field
      disabled={disabled}
      className={clsx("ui-select grid min-w-0 gap-1.5", className)}
    >
      {label ? (
        <Label className="text-xs font-medium text-foreground">{label}</Label>
      ) : null}
      <Listbox
        value={value}
        onChange={onChange}
        disabled={disabled}
        name={name}
      >
        <ListboxButton
          aria-label={label ? undefined : ariaLabel}
          className={clsx(
            "flex min-h-8 min-w-0 w-full items-center gap-2 rounded-lg border border-border/80 bg-card px-2.5 py-1.5 text-left text-xs text-foreground shadow-sm",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
            triggerClassName,
          )}
        >
          {leading}
          <span
            className={clsx(
              "min-w-0 flex-1 truncate",
              !selected && "text-muted-foreground",
            )}
          >
            {selected?.label ?? placeholder}
          </span>
          <ChevronDown
            size={14}
            aria-hidden="true"
            className="shrink-0 text-muted-foreground"
          />
        </ListboxButton>
        <ListboxOptions
          anchor={{ to: "bottom start", gap: 6, padding: 8 }}
          portal
          aria-label={
            ariaLabel ?? (typeof label === "string" ? label : undefined)
          }
          className={clsx(
            "ui-select-options z-[1200] max-h-72 w-[var(--button-width)] min-w-40 overflow-y-auto rounded-xl border border-border bg-card p-1 text-xs text-card-foreground shadow-xl outline-none",
            optionsClassName,
          )}
        >
          {options.map((option) => (
            <ListboxOption
              key={option.value}
              value={option.value}
              disabled={option.disabled}
              aria-label={option.textValue}
              className="group flex cursor-default select-none items-center gap-2 rounded-lg px-2 py-1.5 data-focus:bg-muted data-selected:bg-primary/10 data-selected:text-primary data-disabled:opacity-40"
            >
              {({ selected }) => (
                <>
                  <span className="min-w-0 flex-1">{option.label}</span>
                  <Check
                    size={13}
                    aria-hidden="true"
                    className={clsx("shrink-0", !selected && "invisible")}
                  />
                </>
              )}
            </ListboxOption>
          ))}
        </ListboxOptions>
      </Listbox>
    </Field>
  );
}
