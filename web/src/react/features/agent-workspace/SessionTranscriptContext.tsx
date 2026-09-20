import { createContext, useContext, type ReactNode } from "react";
import { useSessionWorkspaceEnvironment } from "./SessionEnvironmentContext";

export interface TranscriptSessionScope {
  /** Session the rendered reply belongs to, or null outside a session. */
  sessionId: string | null;
  /** Workspace root, used to turn an absolute link into a relative path. */
  workspacePath: string | null;
}

interface ScopedSession {
  sessionId: string | null;
  workspacePath?: string | null;
}

const TranscriptSessionContext = createContext<ScopedSession | null>(null);

/**
 * Session a rendered reply belongs to.
 *
 * A floating child panel or a transcript rendered on its own is not the session
 * the workspace poller tracks, so renderers that know the owner pass it down
 * explicitly. Without a scope, the poller — already keyed to the session on
 * screen — answers instead, which keeps single-use renders working.
 */
export function TranscriptSessionProvider({
  sessionId,
  workspacePath,
  children,
}: {
  sessionId: string | null | undefined;
  workspacePath?: string | null;
  children: ReactNode;
}) {
  return (
    <TranscriptSessionContext.Provider
      value={{ sessionId: sessionId ?? null, workspacePath }}
    >
      {children}
    </TranscriptSessionContext.Provider>
  );
}

export function useTranscriptSession(): TranscriptSessionScope {
  const scoped = useContext(TranscriptSessionContext);
  // Never starts a private poller: an unscoped render inherits whatever the
  // surrounding provider knows, and a scoped one only borrows the workspace
  // path when the provider is tracking that same session.
  const polled = useSessionWorkspaceEnvironment(null);

  if (!scoped) {
    return {
      sessionId: polled.sessionId,
      workspacePath: polled.environment?.workspacePath ?? null,
    };
  }

  const inherited =
    polled.sessionId === scoped.sessionId
      ? (polled.environment?.workspacePath ?? null)
      : null;
  return {
    sessionId: scoped.sessionId,
    workspacePath: scoped.workspacePath ?? inherited,
  };
}
