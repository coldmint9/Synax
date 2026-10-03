import { createContext, useContext, type ReactNode } from "react";
import { useSessionEnvironment } from "./useSessionEnvironment";

type SessionEnvironmentValue = ReturnType<typeof useSessionEnvironment>;

const SessionEnvironmentContext = createContext<SessionEnvironmentValue | null>(
  null,
);

export function SessionEnvironmentProvider({
  sessionId,
  children,
}: {
  sessionId: string | null;
  children: ReactNode;
}) {
  const value = useSessionEnvironment(sessionId);
  return (
    <SessionEnvironmentContext.Provider value={value}>
      {children}
    </SessionEnvironmentContext.Provider>
  );
}

/**
 * Use the shared workspace poller when a provider exists, while keeping the
 * standalone hook available for focused component tests and isolated renders.
 */
export function useSessionWorkspaceEnvironment(
  sessionId: string | null,
): SessionEnvironmentValue {
  const provided = useContext(SessionEnvironmentContext);
  const owned = useSessionEnvironment(provided ? null : sessionId);
  return provided ?? owned;
}
