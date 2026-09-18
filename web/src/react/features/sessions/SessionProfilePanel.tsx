import { memo } from "react";
import { Skeleton } from "@heroui/react";
import { SlidersHorizontal } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useLocale } from "../../../hooks/useLocale";
import { useAgentSessionStore } from "./agentSessionStore";
import { SessionCapabilitiesPanel } from "./SessionCapabilitiesPanel";
import { SessionStatusCard } from "./SessionWorkspace";
import { WorkspaceSection } from "./WorkspaceSection";
import { SessionSystemPromptPanel } from "./SessionSystemPromptPanel";

export const SessionProfilePanel = memo(function SessionProfilePanel({
  sessionId,
}: {
  sessionId: string | null;
}) {
  const { locale } = useLocale();
  const { loading, sessionStats, sessionCapabilities, steps, runs, session } =
    useAgentSessionStore(
      useShallow((s) => ({
        loading: s.detailLoading,
        sessionStats: s.selectedSessionId === sessionId ? s.sessionStats : null,
        sessionCapabilities:
          s.selectedSessionId === sessionId ? s.sessionCapabilities : null,
        steps: s.steps,
        runs: s.runs,
        session: s.sessions.find((item) => item.id === sessionId),
      })),
    );
  if (!sessionId) return null;
  return (
    <div className="work-runtime-details">
      <WorkspaceSection
        key={sessionId}
        icon={<SlidersHorizontal size={13} />}
        title={locale === "zh" ? "运行详情" : "Runtime details"}
        defaultOpen={false}
      >
        {loading && !sessionStats ? (
          <Skeleton className="m-3 h-12 rounded-lg" />
        ) : (
          <>
            {sessionStats && (
              <SessionStatusCard
                stats={sessionStats}
                session={session}
                runs={runs}
                steps={steps}
              />
            )}
            {sessionCapabilities && (
              <SessionCapabilitiesPanel capabilities={sessionCapabilities} />
            )}
            {session && <SessionSystemPromptPanel session={session} />}
            {!sessionStats && !sessionCapabilities && (
              <p className="ws-empty">
                {locale === "zh" ? "暂无运行数据" : "No runtime data yet"}
              </p>
            )}
          </>
        )}
      </WorkspaceSection>
    </div>
  );
});
