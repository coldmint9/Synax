import {
  Listbox,
  ListboxButton,
  ListboxOptions,
  ListboxOption,
} from "@headlessui/react";
import { Check, ChevronDown } from "lucide-react";
import type { BackendId } from "../../../lib/api/agentRuntime";
import { useLocale } from "../../../hooks/useLocale";
import "./agentControls.css";

export function SessionBackendPicker({
  value,
  options,
  disabled,
  onChange,
}: {
  value: BackendId;
  options: Array<{ id: BackendId; label: string }>;
  disabled: boolean;
  onChange: (id: BackendId) => void;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  return (
    <Listbox
      key={String(disabled)}
      value={value}
      onChange={onChange}
      disabled={disabled}
    >
      <ListboxButton
        disabled={disabled}
        aria-label={zh ? "执行后端" : "Execution backend"}
        title={
          disabled
            ? zh
              ? "后端在会话创建时固定；切换后端请新建会话。"
              : "Backend is fixed for this session. Start a new session to switch."
            : undefined
        }
        className="agent-dock-composer-chip agent-mode-trigger"
      >
        <span>
          {options.find((option) => option.id === value)?.label ?? value}
        </span>
        <ChevronDown size={10} aria-hidden />
      </ListboxButton>
      <ListboxOptions
        anchor={{ to: "top end", gap: 8, padding: 8 }}
        portal
        modal={false}
        aria-label={zh ? "执行后端" : "Execution backend"}
        className="agent-mode-popover ui-select-options z-[1200] max-h-80 overflow-y-auto rounded-xl border border-border bg-card p-1 text-card-foreground shadow-lg outline-none"
      >
        {options.map((option) => (
          <ListboxOption
            key={option.id}
            value={option.id}
            className="agent-mode-option flex cursor-default select-none items-center gap-2 rounded-lg px-2.5 py-2 text-xs outline-none data-focus:bg-muted data-selected:bg-primary/10"
          >
            {({ selected }) => (
              <>
                {option.label}
                <Check
                  size={14}
                  aria-hidden
                  className={selected ? "shrink-0" : "invisible shrink-0"}
                />
              </>
            )}
          </ListboxOption>
        ))}
      </ListboxOptions>
    </Listbox>
  );
}
