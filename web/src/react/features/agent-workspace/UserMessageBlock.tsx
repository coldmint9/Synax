import { MediaParts } from "../media/MediaParts";
import type { RuntimeContentPart } from "../../../lib/api/runtimeMedia";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { useLocale } from "../../../hooks/useLocale";
import { MessageActionToolbar } from "./MessageActionToolbar";
import { useSessionHistory } from "./SessionHistoryContext";
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
  const history = useSessionHistory(),
    checkpoint = history?.checkpoint(messageId);
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(content),
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
      !checkpoint ||
      saving ||
      !draft.trim() ||
      draft.trim() === content.trim()
    )
      return;
    setSaving(true);
    try {
      if (await history.request("edit", checkpoint, draft)) setEditing(false);
    } finally {
      setSaving(false);
    }
  };
  const disabledReason =
    history?.reason ||
    (checkpoint?.available
      ? null
      : checkpoint?.reason ||
        (zh
          ? "此消息没有可用的会话检查点"
          : "No conversation checkpoint for this message"));
  return (
    <div className="flex justify-end">
      {editing ? (
        <div className="message-inline-editor">
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
            <span
              className={
                history?.error
                  ? "message-inline-editor-hint text-danger"
                  : "message-inline-editor-hint"
              }
              role={history?.error ? "alert" : undefined}
            >
              {history?.error ||
                (zh
                  ? "重新发送会截断此处之后的对话；不会自动修改工作区文件"
                  : "Resending replaces the conversation from here; workspace files are not changed automatically")}
            </span>
            <Button
              size="sm"
              variant="ghost"
              isDisabled={saving}
              onPress={() => setEditing(false)}
            >
              {zh ? "取消" : "Cancel"}
            </Button>
            <Button
              size="sm"
              variant="primary"
              isPending={saving}
              isDisabled={
                saving || !draft.trim() || draft.trim() === content.trim()
              }
              onPress={() => void save()}
            >
              {zh ? "保存并重新发送" : "Save and resend"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="message-action-group max-w-[min(85%,42rem)]">
          <div className="session-user-message agent-conversation-copy rounded-2xl border border-primary/15 bg-primary/[0.08] px-3.5 py-2.5 text-sm leading-relaxed text-foreground whitespace-pre-wrap shadow-sm">
            {content}
            <MediaParts parts={contentParts} />
          </div>
          <MessageActionToolbar
            role="user"
            text={content}
            disabledReason={disabledReason}
            busy={history?.busy}
            onEdit={() => {
              setDraft(content);
              setEditing(true);
            }}
          />
        </div>
      )}
    </div>
  );
});
