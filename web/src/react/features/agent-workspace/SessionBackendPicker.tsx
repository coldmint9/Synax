import { useState } from "react";
import { ListBox, Popover } from "@heroui/react";
import { ChevronDown } from "lucide-react";
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
  const [open, setOpen] = useState(false);
  return (
    <Popover
      isOpen={!disabled && open}
      onOpenChange={(next) => setOpen(!disabled && next)}
    >
      <Popover.Trigger<"button">
        render={(props) => <button {...props} type="button" />}
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
      </Popover.Trigger>
      <Popover.Content
        placement="top end"
        offset={8}
        className="agent-mode-popover"
      >
        <ListBox
          aria-label={zh ? "执行后端" : "Execution backend"}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={new Set([value])}
          onSelectionChange={(keys) => {
            if (disabled || keys === "all") return;
            const option = options.find((item) => item.id === [...keys][0]);
            if (option) {
              setOpen(false);
              onChange(option.id);
            }
          }}
        >
          {options.map((option) => (
            <ListBox.Item
              key={option.id}
              id={option.id}
              textValue={option.label}
              className="agent-mode-option"
            >
              {option.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Popover.Content>
    </Popover>
  );
}
