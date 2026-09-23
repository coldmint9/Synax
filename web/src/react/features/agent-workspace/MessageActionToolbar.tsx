import { Button, Tooltip } from "@heroui/react";
import { Check, Copy, GitFork, Pencil, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { copyTextToClipboard } from "../../../lib/clipboard";
import { useLocale } from "../../../hooks/useLocale";
import "./messageActions.css";

interface Props {
  role: "user" | "assistant";
  text: string;
  disabledReason?: string | null;
  forkDisabledReason?: string | null;
  rollbackDisabled?: boolean;
  rollbackDisabledReason?: string;
  busy?: boolean;
  onEdit?: () => void;
  onFork?: () => void;
  onRollback?: () => void;
}
export function MessageActionToolbar({
  role,
  text,
  disabledReason,
  forkDisabledReason = disabledReason,
  rollbackDisabled,
  rollbackDisabledReason,
  busy,
  onEdit,
  onFork,
  onRollback,
}: Props) {
  const { locale } = useLocale(),
    zh = locale === "zh";
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    if (timer.current) clearTimeout(timer.current);
    setCopyState((await copyTextToClipboard(text)) ? "copied" : "failed");
    timer.current = setTimeout(() => setCopyState("idle"), 1800);
  };
  const copyLabel =
    copyState === "copied" ? (zh ? "已复制" : "Copied") : zh ? "复制" : "Copy";
  const unavailable =
    disabledReason ||
    (zh
      ? "此消息没有可用的会话检查点"
      : "No conversation checkpoint for this message");
  const button = (
    label: string,
    icon: React.ReactNode,
    action?: () => void,
    disabled = false,
    reason = unavailable,
  ) => (
    <Tooltip delay={350} key={label}>
      <Button
        aria-label={label}
        aria-disabled={disabled || undefined}
        isIconOnly
        size="sm"
        variant="ghost"
        className="message-action-button"
        onPress={() => {
          if (!disabled) action?.();
        }}
      >
        {icon}
      </Button>
      <Tooltip.Content>{disabled ? reason : label}</Tooltip.Content>
    </Tooltip>
  );
  return (
    <div
      className={`message-action-toolbar message-action-toolbar--${role}`}
      role="toolbar"
      aria-label={zh ? "消息操作" : "Message actions"}
    >
      {role === "user" &&
        button(
          zh ? "编辑消息" : "Edit message",
          <Pencil size={15} />,
          onEdit,
          Boolean(disabledReason || busy || !onEdit),
        )}
      {button(
        copyLabel,
        copyState === "copied" ? (
          <Check size={15} className="text-success" />
        ) : (
          <Copy size={15} />
        ),
        () => void copy(),
        !text,
        zh ? "没有可复制的文本" : "No text to copy",
      )}
      {role === "assistant" && (
        <>
          {button(
            zh ? "从此处分叉" : "Fork from here",
            <GitFork size={15} />,
            onFork,
            Boolean(forkDisabledReason || busy || !onFork),
            forkDisabledReason || unavailable,
          )}
          {button(
            zh ? "回滚到此处" : "Roll back to here",
            <RotateCcw size={15} />,
            onRollback,
            Boolean(disabledReason || busy || !onRollback || rollbackDisabled),
            rollbackDisabledReason ??
              (rollbackDisabled && !disabledReason
                ? zh
                  ? "已经位于此处，没有后续内容"
                  : "Already at this checkpoint"
                : unavailable),
          )}
        </>
      )}
      <span
        className="message-action-feedback"
        role="status"
        aria-live="polite"
      >
        {copyState === "copied"
          ? zh
            ? "已复制"
            : "Copied"
          : copyState === "failed"
            ? zh
              ? "复制失败，请手动选择文本"
              : "Copy failed. Select the text manually."
            : ""}
      </span>
    </div>
  );
}
