import { useEffect, useRef } from "react";
import { BotMessageSquare, Maximize2, Minimize2, X } from "lucide-react";
import { useLocale } from "../../shared/hooks/useLocale";
import { SubagentReadonlyView } from "./SubagentReadonlyView";
import { useSessionWorkspace, useSessionWorkspaceStore } from "./state/sessionWorkspaceStore";

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
  const fullscreenRef = useRef<HTMLButtonElement>(null);
  const { subagent } = useSessionWorkspace(ownerSessionId);
  const fullscreen = Boolean(subagent?.fullscreen);
  const zh = locale === "zh";
  useEffect(() => { closeRef.current?.focus(); }, [sessionId]);
  useEffect(() => {
    if (!fullscreen) return;
    const exit = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      useSessionWorkspaceStore.getState().setSubagentFullscreen(ownerSessionId, false);
      fullscreenRef.current?.focus();
    };
    window.addEventListener("keydown", exit);
    return () => window.removeEventListener("keydown", exit);
  }, [fullscreen, ownerSessionId]);

  return (
    <section className="subagent-conversation" aria-label={zh ? `子代理对话：${title}` : `Subagent conversation: ${title}`}>
      <header className="subagent-conversation-header">
        <BotMessageSquare size={16} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-xs" title={title}>{title}</strong>
          <span className="text-[10px] text-muted-foreground">{fullscreen ? (zh ? "子对话 · Esc 返回分栏" : "Subagent · Esc to return to split view") : (zh ? "子对话 · 主对话保持可见" : "Subagent · parent conversation stays open")}</span>
        </div>
        <button ref={fullscreenRef} type="button" className="subagent-conversation-close" aria-label={fullscreen ? (zh ? "退出子代理全屏" : "Exit subagent fullscreen") : (zh ? "全屏查看子代理对话" : "View subagent fullscreen")} title={fullscreen ? (zh ? "退出全屏（Esc）" : "Exit fullscreen (Esc)") : (zh ? "全屏" : "Fullscreen")} aria-pressed={fullscreen} onClick={() => useSessionWorkspaceStore.getState().setSubagentFullscreen(ownerSessionId, !fullscreen)}>
          {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <button ref={closeRef} type="button" className="subagent-conversation-close" aria-label={zh ? "关闭子代理对话" : "Close subagent conversation"} onClick={() => {
          useSessionWorkspaceStore.getState().closeSubagent(ownerSessionId);
          document.querySelector<HTMLButtonElement>(".subagent-island-trigger")?.focus();
        }}><X size={15} /></button>
      </header>
      <div className="subagent-conversation-body">
        <SubagentReadonlyView key={sessionId} sessionId={sessionId} showHeader={false} />
      </div>
    </section>
  );
}
