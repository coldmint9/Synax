import { Menu, MenuButton, MenuItems, MenuAction } from "@/react/components/ui/Menu";
import { LiquidGlassSurface } from "@/react/components/ui/LiquidGlassSurface";
import type { ForkWorkspaceMode } from "../../../lib/api/conversationHistory";
import { Tooltip } from "@/react/components/ui/Tooltip";
import { Button } from "@/react/components/ui/Button";
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
  onFork?: (mode: ForkWorkspaceMode) => void;
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
    id: string,
    label: string,
    icon: React.ReactNode,
    action?: () => void,
    disabled = false,
    reason = unavailable,
  ) => (
    <Tooltip delay={350} key={id} content={<>{disabled ? reason : label}</>}>
      <Button
        aria-label={label}
        aria-disabled={disabled || undefined}
        iconOnly
        size="sm"
        variant="ghost"
        className="message-action-button"
        onClick={() => {
          if (!disabled) action?.();
        }}
      >
        {icon}
      </Button>
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
          "edit",
          zh ? "编辑消息" : "Edit message",
          <Pencil size={15} />,
          onEdit,
          Boolean(disabledReason || busy || !onEdit),
        )}
      {button(
        "copy",
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
          <Menu>
            <Tooltip delay={350} content={forkDisabledReason || (zh ? "从此处分叉" : "Fork from here")}>
              <MenuButton
                aria-label={zh ? "从此处分叉" : "Fork from here"}
                aria-disabled={Boolean(forkDisabledReason || busy || !onFork) || undefined}
                disabled={Boolean(forkDisabledReason || busy || !onFork)}
                className="message-action-button"
              >
                <GitFork size={15} />
              </MenuButton>
            </Tooltip>
            <MenuItems modal={false} className="message-fork-pop" anchor={{ to: "bottom start", gap: 6, padding: 8 }}>
              <LiquidGlassSurface finish="flat" interactive={false} className="message-fork-material">
                <MenuAction disabled={Boolean(busy)} onClick={() => onFork?.("new_worktree")}>
                  {zh ? "在新的工作树上" : "In a new worktree"}
                </MenuAction>
                <MenuAction disabled={Boolean(busy)} onClick={() => onFork?.("reuse_worktree")}>
                  {zh ? "在原工作空间中" : "In the original workspace"}
                </MenuAction>
              </LiquidGlassSurface>
            </MenuItems>
          </Menu>
          {button(
            "rollback",
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
        className="message-action-feedback sr-only"
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
