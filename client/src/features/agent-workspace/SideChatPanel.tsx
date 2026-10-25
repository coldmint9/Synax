import { useEffect, useRef, useState } from "react";
import { MessageCircle, PanelRightClose, RefreshCw, X } from "lucide-react";
import type { AgentSession } from "../../adapters/transport/agentRuntime";
import { agentRuntimeApi } from "../../adapters/transport/agentRuntime";
import { useLocale } from "../../shared/hooks/useLocale";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { SessionComposer } from "./SessionComposer";
import { SubagentReadonlyView } from "./SubagentReadonlyView";
import {
  readSessionBackendId,
  readSynaxPermissionTier,
} from "./synaxSessionTypes";

interface Props {
  projectId: string;
  parentSession: AgentSession;
  session?: AgentSession;
  width: number;
  resizing?: boolean;
  onResize: (event: React.PointerEvent<HTMLDivElement>) => void;
  onClose: () => void;
  onSessionReady: (session: AgentSession) => void;
}

export function SideChatPanel({
  projectId,
  parentSession,
  session: initialSession,
  width,
  resizing = false,
  onResize,
  onClose,
  onSessionReady,
}: Props) {
  const { locale, t } = useLocale();
  const [session, setSession] = useState<AgentSession | undefined>(initialSession);
  const [preparing, setPreparing] = useState(!initialSession);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const liveSession = useAgentSessionStore((state) =>
    session?.id
      ? state.sessions.find((item) => item.id === session.id)
      : undefined,
  );
  const currentSession = liveSession ?? session;

  useEffect(() => {
    setSession(initialSession);
    setPreparing(!initialSession);
    setError(null);
  }, [initialSession?.id]);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);

  const handleClose = () => {
    onClose();
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>('[data-side-chat-trigger="true"]')
        ?.focus({ preventScroll: true });
    });
  };

  useEffect(() => {
    if (initialSession || session || !parentSession.id) return;
    let active = true;
    setPreparing(true);
    setError(null);
    const backendId = readSessionBackendId(parentSession);
    void agentRuntimeApi
      .createSession({
        projectId,
        nodeId: parentSession.nodeId,
        parentSessionId: parentSession.id,
        backendId,
        model: parentSession.model ?? undefined,
        profileId: parentSession.profileId,
        prompt: locale === "zh" ? "侧边聊天" : "Side chat",
        reasoningEffort: parentSession.reasoningEffort ?? undefined,
        permissionTier:
          backendId === "native"
            ? readSynaxPermissionTier(parentSession.sessionMetadata)
            : undefined,
        permissionOverrides: { task: "deny" },
        sessionMetadata: {
          mode: "chat",
          source: "side-chat",
          sideChat: true,
          parentSessionId: parentSession.id,
        },
      })
      .then(({ session: created }) => {
        if (!active) return;
        useAgentSessionStore.setState((state) =>
          state.sessions.some((item) => item.id === created.id)
            ? state
            : { sessions: [created, ...state.sessions] },
        );
        setSession(created);
        onSessionReady(created);
        void useAgentSessionStore.getState().refreshSessions();
      })
      .catch((reason) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setPreparing(false);
      });
    return () => {
      active = false;
    };
  }, [
    initialSession,
    locale,
    onSessionReady,
    parentSession,
    projectId,
    session,
  ]);

  return (
    <aside
      className="side-chat-panel"
      data-resizing={resizing ? "true" : undefined}
      style={{ width }}
    >
      <div
        className="session-panel-resizer session-panel-resizer--right"
        onPointerDown={onResize}
        role="separator"
        aria-label={t("sideChatResize")}
        aria-orientation="vertical"
      />
      <section className="side-chat" aria-label={t("sideChatTitle")}>
        <header className="side-chat-header">
          <span className="side-chat-header-icon" aria-hidden="true">
            <MessageCircle size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <strong className="block truncate text-xs">{t("sideChatTitle")}</strong>
            <span className="block truncate text-[10px] text-muted-foreground">
              {t("sideChatSubtitle")}
            </span>
          </div>
          <span className="side-chat-context-pill" title={t("sideChatContext")}>
            {t("sideChatContext")}
          </span>
          <button
            ref={closeRef}
            type="button"
            className="side-chat-close"
            aria-label={t("sideChatClose")}
            title={t("sideChatClose")}
            onClick={handleClose}
          >
            <PanelRightClose size={15} />
          </button>
        </header>

        <div className="side-chat-body">
          {preparing ? (
            <div className="side-chat-empty" role="status" aria-live="polite">
              <span className="side-chat-empty-icon" aria-hidden="true">
                <RefreshCw size={17} className="animate-spin" />
              </span>
              <strong>{t("sideChatPreparing")}</strong>
              <p>{t("sideChatContext")}</p>
            </div>
          ) : error ? (
            <div className="side-chat-empty" role="alert">
              <span className="side-chat-empty-icon side-chat-empty-icon--error" aria-hidden="true">
                <X size={17} />
              </span>
              <strong>{t("sideChatError")}</strong>
              <p>{error}</p>
            </div>
          ) : currentSession ? (
            <SubagentReadonlyView
              key={currentSession.id}
              sessionId={currentSession.id}
              showHeader={false}
              showTaskDescription={false}
            />
          ) : (
            <div className="side-chat-empty">
              <span className="side-chat-empty-icon" aria-hidden="true">
                <MessageCircle size={17} />
              </span>
              <strong>{t("sideChatEmptyTitle")}</strong>
              <p>{t("sideChatEmptyDescription")}</p>
            </div>
          )}
        </div>

        {currentSession ? (
          <div className="side-chat-composer">
            <SessionComposer
              projectId={projectId}
              session={currentSession}
              layout="footer"
            />
          </div>
        ) : null}
      </section>
    </aside>
  );
}
