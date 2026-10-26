import { useEffect, useRef, useState } from "react";
import { MessageCircle, RefreshCw, X } from "lucide-react";
import { AlertDialog, DialogBody, DialogContainer, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@/shared/ui/ui/Dialog";
import { Button } from "@/shared/ui/ui/Button";
import { useLocale } from "../../shared/hooks/useLocale";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { upsertSideChatSession, useSideChatStore } from "./state/sideChatStore";
import { SessionComposer } from "./SessionComposer";
import { SubagentReadonlyView } from "./SubagentReadonlyView";

export function SideChatPanel({ ownerSessionId }: { ownerSessionId: string }) {
  const { t } = useLocale();
  const chat = useSideChatStore((state) => state.chats[ownerSessionId]);
  const liveSession = useAgentSessionStore((state) =>
    state.sessions.find((item) => item.id === chat?.session?.id),
  );
  const session = liveSession ?? chat?.session;
  const [confirmClose, setConfirmClose] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus({ preventScroll: true }); }, [ownerSessionId]);
  if (!chat) return null;
  const deleting = chat.status === "closing";
  const destroy = async () => {
    try {
      await useSideChatStore.getState().destroy(ownerSessionId);
      // The temporary icon disappears with the window; return to its creator.
      document.querySelector<HTMLButtonElement>('[data-side-chat-trigger="true"]')?.focus({ preventScroll: true });
    } catch {
      // Keep the confirmation, conversation and error visible for retry.
    }
  };

  return (
    <section className="side-chat" aria-label={t("sideChatTitle")}>
      <header className="side-chat-header">
        <span className="side-chat-header-icon" aria-hidden="true"><MessageCircle size={15} /></span>
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-xs">{t("sideChatTitle")}</strong>
          <span className="block truncate text-[11px] text-muted-foreground">{t("sideChatSubtitle")}</span>
        </div>
        <button ref={closeRef} type="button" className="side-chat-close" aria-label={t("sideChatClose")} title={t("sideChatClose")}
          disabled={deleting} onClick={() => setConfirmClose(true)}><X size={15} /></button>
      </header>
      <p className="px-3 py-2 text-xs text-muted-foreground">{t("sideChatContext")}</p>
      <div className="side-chat-body">
        {chat.status === "creating" || (deleting && !session) ? (
          <div className="side-chat-empty" role="status">
            <RefreshCw size={17} className="animate-spin" aria-hidden="true" />
            <strong>{t("sideChatPreparing")}</strong>
          </div>
        ) : session ? (
          <SubagentReadonlyView key={session.id} sessionId={session.id} showHeader={false} onSessionChange={upsertSideChatSession} />
        ) : (
          <div className="side-chat-empty">
            <strong>{t("sideChatError")}</strong>
            <Button variant="secondary" size="sm" onClick={() => useSideChatStore.getState().retry(ownerSessionId)}>{t("planRetry")}</Button>
          </div>
        )}
      </div>
      {chat.error && !confirmClose ? <p role="alert" className="px-3 py-2 text-xs text-danger">{chat.error}</p> : null}
      {session && !deleting ? (
        <div className="side-chat-composer"><SessionComposer projectId={session.projectId} session={session} layout="footer" /></div>
      ) : null}
      <AlertDialog open={confirmClose} onClose={() => setConfirmClose(false)} dismissible={!deleting}>
        <DialogContainer size="sm"><DialogPanel>
          <DialogHeader><DialogTitle>{t("sideChatCloseConfirmTitle")}</DialogTitle></DialogHeader>
          <DialogBody>
            {t("sideChatCloseConfirmDescription")}
            {chat.error ? <p role="alert" className="mt-3 text-xs text-danger">{chat.error}</p> : null}
          </DialogBody>
          <DialogFooter>
            <Button autoFocus variant="ghost" size="sm" disabled={deleting} onClick={() => setConfirmClose(false)}>{t("commonCancel")}</Button>
            <Button variant="primary" size="sm" pending={deleting} disabled={deleting} onClick={() => void destroy()}>{t("sideChatCloseConfirmAction")}</Button>
          </DialogFooter>
        </DialogPanel></DialogContainer>
      </AlertDialog>
    </section>
  );
}
