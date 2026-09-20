import { memo } from "react";
import { ScrollText } from "lucide-react";
import type { AgentSession } from "../../../lib/api/agentRuntime";
import { useLocale } from "../../../hooks/useLocale";
import { readSessionBackendId } from "./synaxSessionTypes";
import { WorkspaceSection } from "./WorkspaceSection";

export const SessionSystemPromptPanel = memo(function SessionSystemPromptPanel({
  session,
}: {
  session: AgentSession;
}) {
  const { t } = useLocale();
  if (readSessionBackendId(session) !== "native") return null;
  const latestPrompt = session.sessionMetadata?.latestSystemPrompt;
  const prompt = typeof latestPrompt === "string" ? latestPrompt : "";

  return (
    <WorkspaceSection
      key={session.id}
      icon={<ScrollText size={13} />}
      title={t("sessionSystemPrompt")}
      defaultOpen={false}
    >
      <p className="px-2 py-2 text-[10px] text-muted-foreground">
        {t("sessionSystemPromptDescription")}
      </p>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words px-2 pb-2 text-[10px] leading-relaxed text-muted-foreground">
        {prompt.trim() ? prompt : t("sessionSystemPromptEmpty")}
      </pre>
    </WorkspaceSection>
  );
});
