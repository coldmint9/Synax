import { useEffect, useRef, useState } from "react";
import { MessageCircle, PanelRightClose, RefreshCw, X } from "lucide-react";
import type { AgentSession } from "../../adapters/transport/agentRuntime";
import { agentRuntimeApi } from "../../adapters/transport/agentRuntime";
import { useLocale } from "../../shared/hooks/useLocale";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { SessionComposer } from "./SessionComposer";
import { SubagentReadonlyView } from "./SubagentReadonlyView";
import { sideChatSessionRequest } from "./sideChatSession";

interface Props {
  projectId: string;
  parentSession: AgentSession;
  session?: AgentSession;
  onClose: () => void;
  onSessionReady: (session: AgentSession) => void;
}

export function SideChatPanel({
  projectId,
  parentSession,
  session: initialSession,
  onClose,
  onSessionReady,
}: Props) {
  const { t } = useLocale();
  const sideChatTitle = t("sideChatTitle");
  const [session, setSession] = useState<AgentSession | undefined>(
    initialSession,
  );
  const [preparing, setPreparing] = useState(!initialSession);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const creationRef = useRef<{
    sourceId: string;
    promise: ReturnType<typeof agentRuntimeApi.createSession>;
  } | null>(null);
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
    // Parent status updates, Activity reveals and StrictMode effect replay must
    // observe the same creation request rather than create extra sessions.
    if (creationRef.current?.sourceId !== parentSession.id) {
      creationRef.current = {
        sourceId: parentSession.id,
        promise: agentRuntimeApi.createSession(
          sideChatSessionRequest(parentSession, sideChatTitle),
        ),
      };
    }
    void creationRef.current.promise
      .then(({ session: created }) => {
        if (!active) return;
        useAgentSessionStore.setState((state) =>
          (state.projectId !== null && state.projectId !== created.projectId) ||
          state.sessions.some((item) => item.id === created.id)
            ? state
            : { sessions: [created, ...state.sessions] },
        );
        setSession(created);
        setPreparing(false);
        onSessionReady(created);
        void useAgentSessionStore.getState().refreshSessions();
      })
      .catch((reason) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setPreparing(false);
      });
    return () => {
      active = false;
    };
  }, [
    initialSession,
    onSessionReady,
    parentSession,
    projectId,
    session,
    sideChatTitle,
    attempt,
  ]);

  return (
    <section className="side-chat" aria-label={t("sideChatTitle")}>
      <header className="side-chat-header">
        <span className="side-chat-header-icon" aria-hidden="true">
          <MessageCircle size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-xs">
            {t("sideChatTitle")}
          </strong>
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
            <span
              className="side-chat-empty-icon side-chat-empty-icon--error"
              aria-hidden="true"
            >
              <X size={17} />
            </span>
            <strong>{t("sideChatError")}</strong>
            <p>{error}</p>
            <button
              type="button"
              className="rounded-md px-3 py-1.5 text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              onClick={() => {
                creationRef.current = null;
                setAttempt((value) => value + 1);
              }}
            >
              {t("planRetry")}
            </button>
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
  );
}
