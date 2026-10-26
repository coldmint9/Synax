import { MessageCircle } from "lucide-react";
import { IslandSurface } from "../../app/layouts/IslandSurface";
import { Tooltip } from "@/shared/ui/ui/Tooltip";
import { useLocale } from "../../shared/hooks/useLocale";
import { useSideChatStore } from "./state/sideChatStore";
import { useSessionWorkspace, useSessionWorkspaceStore } from "./state/sessionWorkspaceStore";
import "./sideChatIsland.css";

export function SideChatIsland({ sessionId }: { sessionId: string }) {
  const { t } = useLocale();
  const chat = useSideChatStore((state) => state.chats[sessionId]);
  const workspace = useSessionWorkspace(sessionId);
  if (!chat) return null;
  const active = !workspace.subagent && workspace.presentation !== "focus";
  const handleClick = () => {
    useSessionWorkspaceStore.getState().closeSubagent(sessionId);
    useSessionWorkspaceStore.getState().exitFocus(sessionId);
  };

  return (
    <div className="side-chat-island-anchor">
      <IslandSurface>
        <Tooltip content={t("sideChatTitle")}>
          <button
            type="button"
            className="side-chat-island-trigger"
            data-active="true"
            aria-label={t("sideChatTitle")}
            aria-pressed={active}
            title={t("sideChatTitle")}
            onClick={handleClick}
          >
            <MessageCircle size={17} aria-hidden="true" />
          </button>
        </Tooltip>
      </IslandSurface>
    </div>
  );
}
