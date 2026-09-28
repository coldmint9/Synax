import {
  Listbox,
  ListboxButton,
  ListboxOptions,
  ListboxOption,
} from "@headlessui/react";
import { OverlayStateObserver } from "@/react/components/ui/OverlayStateObserver";
import {
  Check,
  ChevronDown,
  MessageCircle,
  Target,
} from "lucide-react";
import type { AgentSessionMode } from "../../../lib/api/agentRuntime";
import { useLocale } from "../../../hooks/useLocale";
import "./agentControls.css";

interface Props {
  mode: AgentSessionMode | "plan_node";
  disabled: boolean;
  description: string;
  onOpenChange?: (open: boolean) => void;
  onChange: (mode: AgentSessionMode) => void;
}

export function SessionModePicker({
  mode,
  disabled,
  description,
  onChange,
  onOpenChange,
}: Props) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const options = [
    {
      id: "chat",
      label: zh ? "对话" : "Chat",
      Icon: MessageCircle,
      detail: zh
        ? "直接提问，或交给 Synax 完成"
        : "Ask anything or get work done",
    },
    {
      id: "goal",
      label: zh ? "目标" : "Goal",
      Icon: Target,
      detail: zh
        ? "持续推进，直到目标验收完成"
        : "Keep working toward an accepted goal",
    },
  ] as const;
  const visibleMode = mode === "plan" ? "chat" : mode;
  const Icon = options.find((option) => option.id === visibleMode)?.Icon ?? MessageCircle;
  const label =
    options.find((option) => option.id === visibleMode)?.label ??
    (zh ? "计划节点" : "Plan node");
  return (
    <Listbox
      key={String(disabled)}
      value={visibleMode}
      disabled={disabled}
      onChange={(value) => {
        const option = options.find((item) => item.id === value);
        if (option && option.id !== mode) onChange(option.id);
      }}
    >
      {({ open }) => (
        <>
          <OverlayStateObserver open={open} onOpenChange={onOpenChange} />
          <ListboxButton
            aria-label={zh ? "会话模式" : "Session mode"}
            aria-description={description}
            title={description}
            disabled={disabled}
            data-mode={visibleMode}
            className="agent-dock-composer-chip agent-mode-trigger"
          >
            <Icon size={13} aria-hidden />
            <span>{label}</span>
            <ChevronDown size={10} aria-hidden />
          </ListboxButton>
          <ListboxOptions
            anchor={{ to: "top start", gap: 8, padding: 8 }}
            portal
            modal={false}
            aria-label={zh ? "会话模式" : "Session mode"}
            className="agent-mode-popover agent-workflow-popover ui-select-options z-[1200] max-h-80 overflow-y-auto rounded-xl border border-border bg-card p-1 text-card-foreground shadow-lg outline-none"
          >
            {options.map((option) => (
              <ListboxOption
                key={option.id}
                value={option.id}
                className="agent-mode-option agent-mode-option--workflow flex cursor-default select-none items-center gap-2 rounded-lg px-2.5 py-2 text-xs outline-none data-focus:bg-muted data-selected:bg-primary/10"
              >
                {({ selected }) => (
                  <>
                    <option.Icon size={17} aria-hidden />
                    <span className="agent-mode-option-copy">
                      <strong>{option.label}</strong>
                      <small>{option.detail}</small>
                    </span>
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
        </>
      )}
    </Listbox>
  );
}
