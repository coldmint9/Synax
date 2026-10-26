import { MediaParts } from "../media/MediaParts";
import type { RuntimeContentPart } from "../../adapters/transport/runtimeMedia";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/shared/ui/ui/Button";
import { useLocale } from "../../shared/hooks/useLocale";
import { useShellStore } from "../../shared/state/shellStore";
import { MessageActionToolbar } from "./MessageActionToolbar";
import { useSessionHistory } from "./SessionHistoryContext";
import { TextAttachmentCard } from "./TextAttachmentCard";
interface Props {
  content: string;
  contentParts?: RuntimeContentPart[];
  messageId?: string;
}
export const UserMessageBlock = memo(function UserMessageBlock({
  content,
  contentParts,
  messageId,
}: Props) {
  const { locale } = useLocale(),
    zh = locale === "zh";
  const userMessageFontWeight = useShellStore(
    (state) => state.preferences.userMessageFontWeight,
  );
  const history = useSessionHistory();
  const { messageText, attachments } = useMemo(() => {
    const attachments = contentParts?.filter(
      (part): part is Extract<RuntimeContentPart, { type: "text" }> & { attachmentName: string } =>
        part.type === "text" && Boolean(part.attachmentName),
    ) ?? [];
    return {
      attachments,
      // Only split messages with explicit attachment metadata; ordinary and
      // legacy messages retain their original content.
      messageText: attachments.length
        ? contentParts!.filter((part) => part.type === "text" && !part.attachmentName)
          .map((part) => part.type === "text" ? part.text : "").join("\n")
        : content,
    };
  }, [content, contentParts]);
  const attachmentCards = attachments.map((part, index) => (
    <TextAttachmentCard key={`${index}-${part.attachmentName}`} name={part.attachmentName} text={part.text} />
  ));
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(messageText),
    [saving, setSaving] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (editing && textarea.current) {
      textarea.current.style.height = "auto";
      textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 400)}px`;
    }
  }, [editing, draft]);
  const save = async () => {
    if (
      !history ||
      history.canEditMessages === false ||
      !messageId ||
      saving ||
      !draft.trim()
    )
      return;
    setSaving(true);
    try {
      if (await history.edit(messageId, draft)) setEditing(false);
    } finally {
      setSaving(false);
    }
  };
  const disabledReason =
    history?.editReason(messageId) ?? (!history ? (zh ? "会话尚未加载" : "Conversation is not loaded") : null);
  return (
    <div className="flex justify-end">
      {editing && history?.canEditMessages !== false ? (
        <div className="message-inline-editor">
          {attachmentCards}
          <textarea
            ref={textarea}
            autoFocus
            value={draft}
            aria-label={zh ? "编辑已发送消息" : "Edit sent message"}
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Escape" && !saving) {
                e.preventDefault();
                setEditing(false);
              }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void save();
              }
            }}
          />
          <MediaParts parts={contentParts?.filter((p) => p.type !== "text")} />
          <div className="message-inline-editor-footer">
            <span className="message-inline-editor-hint" role={history?.error ? "alert" : undefined}>
              {history?.error || (zh
                ? "重新发送将替换此消息并删除后续对话，工作区文件保持不变"
                : "Resending replaces this message and removes later conversation. Workspace files stay unchanged.")}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              {zh ? "取消" : "Cancel"}
            </Button>
            <Button
              size="sm"
              variant="primary"
              pending={saving}
              disabled={
                saving || !draft.trim()
              }
              onClick={() => void save()}
            >
              {zh ? "发送" : "Send"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="message-action-group min-w-0 max-w-[min(85%,42rem)]">
          <div className="flex min-w-0 flex-col gap-2">
            {attachmentCards}
            {messageText ? (
              <div
                className="session-user-message agent-conversation-copy rounded-2xl border border-primary/15 bg-primary/[0.08] px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap shadow-sm"
                style={{ fontWeight: userMessageFontWeight }}
              >
                {messageText}
              </div>
            ) : null}
            <MediaParts parts={contentParts} />
          </div>
          <MessageActionToolbar
            role="user"
            text={content}
            disabledReason={disabledReason}
            busy={history?.busy}
            onEdit={history?.canEditMessages === false ? undefined : () => {
              setDraft(messageText);
              setEditing(true);
            }}
          />
        </div>
      )}
    </div>
  );
});
