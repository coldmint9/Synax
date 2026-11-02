import { memo, useState } from "react";
import { SubagentControls } from "./SubagentControls";
import { useLocale } from "../../shared/hooks/useLocale";
import { SubagentIdentity } from "./SubagentIdentity";
import { InteractiveSubagentView } from "./InteractiveSubagentView";
import { getConversationController } from "./state/conversationController";
import { useConversationState } from "./state/useConversationState";

function SubagentConversation({ sessionId, showHeader, onDestroyed }: {
  sessionId: string;
  showHeader: boolean;
  onDestroyed: () => void;
}) {
  const session = useConversationState(sessionId, state => state.session);
  const { locale } = useLocale();
  const header = showHeader && session ? <div className="subagent-detail-header">
    <SubagentIdentity session={session} />
    <span className="subagent-detail-id" title={session.id}>{session.id.slice(0, 8)}</span>
    <span className="ml-auto rounded bg-secondary/60 px-1.5 py-0.5 text-[9px] text-muted-foreground">{locale === "zh" ? "只读" : "Read only"}</span>
    <SubagentControls
      sessionId={sessionId}
      parentSessionId={session.parentSessionId}
      status={session.status}
      title={session.title || session.prompt}
      onStopped={() => void getConversationController(sessionId).refresh()}
      onDestroyed={onDestroyed}
    />
  </div> : undefined;
  return <InteractiveSubagentView sessionId={sessionId} header={header} />;
}

export const SubagentReadonlyView = memo(function SubagentReadonlyView({
  sessionId,
  showHeader = true,
}: {
  sessionId: string;
  showHeader?: boolean;
}) {
  const { t } = useLocale();
  const [destroyedId, setDestroyedId] = useState<string | null>(null);
  return destroyedId === sessionId
    ? <div className="p-4 text-xs text-muted-foreground">{t("subSessionDestroyed")}</div>
    : <SubagentConversation sessionId={sessionId} showHeader={showHeader} onDestroyed={() => setDestroyedId(sessionId)} />;
});
