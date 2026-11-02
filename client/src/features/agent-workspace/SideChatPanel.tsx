import { useEffect, useRef, useState } from "react";
import { MessageCircle, PanelRightClose, RefreshCw, Trash2, X } from "lucide-react";
import type { AgentSession } from "../../adapters/transport/agentRuntime";
import { agentRuntimeApi } from "../../adapters/transport/agentRuntime";
import { useLocale } from "../../shared/hooks/useLocale";
import {
  clearRuntimeResourcePendingRemoval,
  markRuntimeResourcePendingRemoval,
  markRuntimeResourcesRemoved,
} from "../../shared/lib/runtimeResourceRegistry";
import { Button } from "../../shared/ui/ui/Button";
import { AlertDialog, DialogBody, DialogContainer, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "../../shared/ui/ui/Dialog";
import { SideChatConversation } from "./SideChatConversation";

interface Props {
  parentSession: AgentSession;
  /** Side chat stored for this conversation; null while none exists yet. */
  sideChatId?: string | null;
  /** Collapse back to the floating pill without discarding the side chat. */
  onCollapse: () => void;
  onSessionReady: (sessionId: string) => void;
  /** The stored side chat is gone: drop it so the panel creates a fresh one. */
  onSessionMissing: () => void;
  /** The user discarded the side chat: the page drops the slot entirely. */
  onDeleted: () => void;
}

function isMissingSideChat(error: unknown): boolean {
  return (error as { statusCode?: number } | null)?.statusCode === 404;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SideChatPanel({
  parentSession,
  sideChatId,
  onCollapse,
  onSessionReady,
  onSessionMissing,
  onDeleted,
}: Props) {
  const { t } = useLocale();
  const [session, setSession] = useState<AgentSession | undefined>();
  const [preparing, setPreparing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const adoptionRef = useRef<{
    sideChatId: string;
    request: ReturnType<typeof agentRuntimeApi.getSessionSummary>;
  } | null>(null);
  const creationRef = useRef<{
    sourceId: string;
    promise: ReturnType<typeof agentRuntimeApi.createSideChat>;
  } | null>(null);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);

  // Discarding is the only path that erases data: collapse keeps the child so
  // the pill can reopen it.
  const discard = async () => {
    if (deleting || !session) return;
    setDeleting(true);
    setDeleteError(null);
    // Requests already dispatched for this side chat come back as NOT_FOUND
    // once its data is gone. Marking it here keeps those expected replies from
    // reaching the user as one stray "resource not found" toast.
    markRuntimeResourcePendingRemoval(session.id);
    try {
      const deleted = await agentRuntimeApi.deleteSideChat(parentSession.id);
      markRuntimeResourcesRemoved([session.id, ...deleted.deletedSessionIds]);
      if (!mountedRef.current) return;
      creationRef.current = null;
      adoptionRef.current = null;
      setSession(undefined);
      setConfirming(false);
      setDeleting(false);
      onDeleted();
    } catch (reason) {
      clearRuntimeResourcePendingRemoval(session.id);
      if (!mountedRef.current) return;
      setDeleteError(messageOf(reason));
      setDeleting(false);
    }
  };

  // A restored layout only knows the side chat id, so reading it back keeps the
  // panel the same whether it was created now or on a previous visit.
  useEffect(() => {
    if (!sideChatId || session?.id === sideChatId) return;
    // StrictMode replays this effect; every replay observes the same read
    // instead of starting another one that would never be applied.
    if (adoptionRef.current?.sideChatId !== sideChatId) {
      adoptionRef.current = {
        sideChatId,
        // The panel owns the "stored side chat is gone" answer: a discarded or
        // never-committed child must not be toasted by the HTTP layer.
        request: agentRuntimeApi.getSessionSummary(sideChatId, { silent: true }),
      };
      setSession(undefined);
      setPreparing(true);
      setError(null);
    }
    let active = true;
    void adoptionRef.current.request
      .then(({ session: stored }) => {
        if (!active) return;
        setSession(stored);
        setPreparing(false);
      })
      .catch((reason) => {
        if (!active) return;
        if (isMissingSideChat(reason)) {
          adoptionRef.current = null;
          onSessionMissing();
          return;
        }
        setError(messageOf(reason));
        setPreparing(false);
      });
    return () => {
      active = false;
    };
  }, [attempt, onSessionMissing, session?.id, sideChatId]);

  useEffect(() => {
    if (sideChatId || session || !parentSession.id) return;
    let active = true;
    setPreparing(true);
    setError(null);
    // Parent status updates, Activity reveals and StrictMode effect replay must
    // observe the same creation request rather than create extra sessions.
    if (creationRef.current?.sourceId !== parentSession.id) {
      creationRef.current = {
        sourceId: parentSession.id,
        promise: agentRuntimeApi.createSideChat(parentSession.id),
      };
    }
    void creationRef.current.promise
      .then(({ session: created }) => {
        if (!active) return;
        setSession(created);
        setPreparing(false);
        onSessionReady(created.id);
      })
      .catch((reason) => {
        if (!active) return;
        setError(messageOf(reason));
        setPreparing(false);
      });
    return () => {
      active = false;
    };
  }, [attempt, onSessionReady, parentSession.id, session, sideChatId]);

  return (
    <>
      <section className="side-chat" aria-label={t("sideChatTitle")}>
        <header className="side-chat-header">
          <span className="side-chat-header-icon" aria-hidden="true">
            <MessageCircle size={13} />
          </span>
          <div className="min-w-0 flex-1">
            <strong className="block truncate text-xs">{t("sideChatTitle")}</strong>
          </div>
          {session ? (
            <button
              ref={deleteRef}
              type="button"
              className="side-chat-delete"
              aria-label={t("sideChatDelete")}
              title={t("sideChatDelete")}
              onClick={() => {
                setDeleteError(null);
                setConfirming(true);
              }}
            >
              <Trash2 size={14} />
            </button>
          ) : null}
          <button
            ref={closeRef}
            type="button"
            className="side-chat-close"
            aria-label={t("sideChatCollapse")}
            title={t("sideChatCollapse")}
            onClick={onCollapse}
          >
            <PanelRightClose size={14} />
          </button>
        </header>

        {session ? (
          <SideChatConversation key={session.id} session={session} />
        ) : (
          <div className="side-chat-body">
            {preparing ? (
              <div className="side-chat-empty" role="status" aria-live="polite">
                <span className="side-chat-empty-icon" aria-hidden="true">
                  <RefreshCw size={17} className="animate-spin" />
                </span>
                <strong>{t("sideChatPreparing")}</strong>
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
                    adoptionRef.current = null;
                    setAttempt((value) => value + 1);
                  }}
                >
                  {t("planRetry")}
                </button>
              </div>
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
        )}
      </section>

      {confirming ? (
        <AlertDialog
          open
          dismissible={!deleting}
          onClose={() => {
            if (deleting) return;
            setConfirming(false);
            deleteRef.current?.focus({ preventScroll: true });
          }}
        >
          <DialogContainer size="sm">
            <DialogPanel>
              <div className="flex flex-col gap-4">
                <DialogHeader>
                  <DialogTitle>{t("sideChatDelete")}</DialogTitle>
                </DialogHeader>
                <DialogBody className="space-y-3 text-sm">
                  <DialogDescription>{t("sideChatDeleteDescription")}</DialogDescription>
                  {deleteError ? (
                    <p role="alert" data-error-toast="off" className="break-words text-danger">
                      {t("sideChatDeleteFailed")}：{deleteError}
                    </p>
                  ) : null}
                </DialogBody>
                <DialogFooter>
                  <Button
                    variant="ghost"
                    disabled={deleting}
                    autoFocus
                    onClick={() => {
                      setConfirming(false);
                      deleteRef.current?.focus({ preventScroll: true });
                    }}
                  >
                    {t("commonCancel")}
                  </Button>
                  <Button
                    variant="danger"
                    pending={deleting}
                    disabled={deleting}
                    onClick={() => void discard()}
                  >
                    {t("sideChatDelete")}
                  </Button>
                </DialogFooter>
              </div>
            </DialogPanel>
          </DialogContainer>
        </AlertDialog>
      ) : null}
    </>
  );
}
