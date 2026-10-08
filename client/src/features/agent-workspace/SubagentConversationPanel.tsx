import { useEffect, useRef } from "react";
import { BotMessageSquare, X } from "lucide-react";
import { useLocale } from "../../shared/hooks/useLocale";
import { SubagentReadonlyView } from "./SubagentReadonlyView";
import { useSessionWorkspaceStore } from "./state/sessionWorkspaceStore";

export function SubagentConversationPanel({
  ownerSessionId,
  sessionId,
  title,
}: {
  ownerSessionId: string;
  sessionId: string;
  title: string;
}) {
  const { locale } = useLocale();
  const closeRef = useRef<HTMLButtonElement>(null);
  const zh = locale === "zh";
  useEffect(() => { closeRef.current?.focus(); }, [sessionId]);

  return (
    <section className="subagent-conversation" aria-label={zh ? `子代理对话：${title}` : `Subagent conversation: ${title}`}>
      <header className="subagent-conversation-header">
        <BotMessageSquare size={16} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-xs" title={title}>{title}</strong>
          <span className="text-[10px] text-muted-foreground">{zh ? "子对话 · 主对话保持可见" : "Subagent · parent conversation stays open"}</span>
        </div>
        <button ref={closeRef} type="button" className="subagent-conversation-close" aria-label={zh ? "关闭子代理对话" : "Close subagent conversation"} onClick={() => {
          useSessionWorkspaceStore.getState().closeSubagent(ownerSessionId);
          document.querySelector<HTMLButtonElement>(".subagent-island-trigger")?.focus();
        }}><X size={15} /></button>
      </header>
      <div className="subagent-conversation-body">
        <SubagentReadonlyView key={sessionId} sessionId={sessionId} />
      </div>
    </section>
  );
}
