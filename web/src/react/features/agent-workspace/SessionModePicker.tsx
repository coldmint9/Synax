import { useState } from "react";
import { ListBox, Popover } from "@heroui/react";
import { ChevronDown, MessageCircle, ListTodo, Target } from "lucide-react";
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
  const [open, setOpen] = useState(false);
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
      id: "plan",
      label: zh ? "计划" : "Plan",
      Icon: ListTodo,
      detail: zh
        ? "先讨论方案，确认后再执行"
        : "Explore first, execute when ready",
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
  const Icon = options.find((option) => option.id === mode)?.Icon ?? ListTodo;
  const changeOpen = (value: boolean) => {
    setOpen(value);
    onOpenChange?.(value);
  };
  const label =
    options.find((option) => option.id === mode)?.label ??
    (zh ? "计划节点" : "Plan node");
  return (
    <Popover
      isOpen={!disabled && open}
      onOpenChange={(value) => changeOpen(!disabled && value)}
    >
      <Popover.Trigger<"button">
        render={(props) => <button {...props} type="button" />}
        aria-label={zh ? "会话模式" : "Session mode"}
        aria-description={description}
        title={description}
        disabled={disabled}
        data-mode={mode}
        className="agent-dock-composer-chip agent-mode-trigger"
      >
        <Icon size={13} aria-hidden />
        <span>{label}</span>
        <ChevronDown size={10} aria-hidden />
      </Popover.Trigger>
      <Popover.Content
        placement="top start"
        offset={8}
        className="agent-mode-popover agent-workflow-popover"
      >
        <ListBox
          autoFocus
          aria-label={zh ? "会话模式" : "Session mode"}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={new Set([mode])}
          onSelectionChange={(keys) => {
            if (disabled || keys === "all") return;
            const selected = [...keys][0];
            const option = options.find((item) => item.id === selected);
            if (option) {
              changeOpen(false);
              if (option.id !== mode) onChange(option.id);
            }
          }}
        >
          {options.map((option) => (
            <ListBox.Item
              key={option.id}
              id={option.id}
              textValue={option.label}
              className="agent-mode-option agent-mode-option--workflow"
            >
              <option.Icon size={17} aria-hidden />
              <span className="agent-mode-option-copy">
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </span>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Popover.Content>
    </Popover>
  );
}
