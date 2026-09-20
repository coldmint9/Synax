import { useEffect } from "react";

export function refreshWorkspace(sessionId: string, rootId?: string) {
  document.dispatchEvent(
    new CustomEvent("workspace:refresh", { detail: { sessionId, rootId } }),
  );
}
export function useWorkspaceRefresh(
  sessionId: string | null,
  reload: () => void,
  rootId?: string,
) {
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (
        event as CustomEvent<{ sessionId: string; rootId?: string }>
      ).detail;
      if (
        detail?.sessionId === sessionId &&
        (!rootId || !detail.rootId || rootId === detail.rootId)
      )
        reload();
    };
    document.addEventListener("workspace:refresh", listener);
    return () => document.removeEventListener("workspace:refresh", listener);
  }, [sessionId, rootId, reload]);
}
