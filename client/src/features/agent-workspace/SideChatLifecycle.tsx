import { useEffect } from "react";
import { agentRuntimeApi } from "../../adapters/transport/agentRuntime";
import { useSideChatStore } from "./state/sideChatStore";

/** Navigating within Synax keeps temporary windows; leaving the app warns. */
export function SideChatLifecycle() {
  const hasChats = useSideChatStore((state) => Object.keys(state.chats).length > 0);
  useEffect(() => {
    if (!hasChats) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const cleanup = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      for (const chat of Object.values(useSideChatStore.getState().chats)) {
        if (chat.session)
          void agentRuntimeApi.destroySideChatOnUnload(chat.session.id).catch(() => undefined);
        else
          void useSideChatStore.getState().destroy(chat.source.id).catch(() => undefined);
      }
    };
    window.addEventListener("beforeunload", warn);
    window.addEventListener("pagehide", cleanup);
    return () => {
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener("pagehide", cleanup);
    };
  }, [hasChats]);
  return null;
}
