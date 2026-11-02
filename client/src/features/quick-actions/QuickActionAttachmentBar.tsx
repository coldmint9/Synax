import { Sparkles, X } from "lucide-react";
import { findQuickAction, type Locale, type QuickActionAttachment } from "./quickActions";
import "./quickActionAttachment.css";

interface Props {
  attachment: QuickActionAttachment;
  locale: Locale;
  /** The composer already has the context this procedure needs. */
  ready?: boolean;
  onDismiss: () => void;
}

/**
 * The attached procedure sits above the input instead of being sent. It names
 * the missing information and can be removed without touching typed text.
 */
export function QuickActionAttachmentBar({ attachment, locale, ready = !attachment.requiresInput, onDismiss }: Props) {
  const zh = locale === "zh";
  const Icon = findQuickAction(attachment.actionId)?.icon ?? Sparkles;
  const hint = attachment.hint?.trim();
  const detail = attachment.requiresInput && !ready
    ? `${zh ? "需补充" : "Needs"}${hint ? ` · ${hint}` : ""}`
    : zh ? "就绪，可直接发送" : "Ready to send";
  return (
    <div className="quick-action-attachment" data-input={attachment.requiresInput && !ready ? "true" : undefined}>
      <span className="quick-action-attachment__icon"><Icon size={14} aria-hidden="true" /></span>
      <span className="quick-action-attachment__copy">
        <strong>{attachment.title}</strong>
        <small title={hint}>{detail}</small>
      </span>
      <button type="button" className="quick-action-attachment__remove"
        aria-label={zh ? `移除快捷操作：${attachment.title}` : `Remove quick action: ${attachment.title}`}
        onClick={onDismiss}>
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
